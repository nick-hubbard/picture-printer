import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 25 * 1024 * 1024, files: 30 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PRINT_DRY_RUN = process.env.PRINT_DRY_RUN !== 'false';
const PRINTER_NAME = process.env.PRINTER_NAME || '';
const PRINT_DIR = path.join(__dirname, 'prints');
const GOOGLE_PHOTOS_DIR = path.join(__dirname, 'google-photos');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const GOOGLE_PHOTOS_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const googlePhotos = new Map();
let googleToken;
const DPI = 300;
const PAGE = {
  label: 'Letter',
  widthIn: 8.5,
  heightIn: 11,
  marginIn: 0.25,
  gapIn: 0.1,
};

const PRINT_SIZES = {
  '2x3': { label: '2 x 3', widthIn: 2, heightIn: 3 },
  '2x3.5': { label: '2 x 3.5', widthIn: 2, heightIn: 3.5 },
  '3x4': { label: '3 x 4', widthIn: 3, heightIn: 4 },
  '4x4': { label: '4 x 4', widthIn: 4, heightIn: 4 },
  '3.5x5': { label: '3.5 x 5', widthIn: 3.5, heightIn: 5 },
  '4x6': { label: '4 x 6', widthIn: 4, heightIn: 6 },
  '5x7': { label: '5 x 7', widthIn: 5, heightIn: 7 },
};

app.use(express.static(path.join(__dirname, 'public')));
app.use('/prints', express.static(PRINT_DIR));
app.use('/google-photos', express.static(GOOGLE_PHOTOS_DIR));

app.get('/api/options', (_req, res) => {
  res.json({
    sizes: Object.entries(PRINT_SIZES).map(([value, size]) => ({ value, label: size.label })),
    dryRun: PRINT_DRY_RUN,
    printerName: PRINTER_NAME || 'System default printer',
    googlePhotosEnabled: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    googlePhotosConnected: hasGoogleToken(),
  });
});

app.get('/auth/google', (_req, res) => {
  const authUrl = createGoogleAuthUrl();
  if (!authUrl) {
    return res.status(400).send('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before connecting Google Photos.');
  }
  return res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send(`Google authorization failed: ${error}`);
  }
  if (!code || !state || !isValidGoogleState(String(state))) {
    return res.status(400).send('Google authorization state was invalid. Please try again.');
  }

  try {
    googleToken = await exchangeGoogleCode(String(code));
    return res.send('<script>window.close();</script><p>Google Photos connected. You can close this window.</p>');
  } catch (exchangeError) {
    return res.status(500).send(exchangeError.message || 'Unable to connect Google Photos.');
  }
});

app.get('/api/google-photos/status', (_req, res) => {
  res.json({
    configured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    connected: hasGoogleToken(),
  });
});

app.post('/api/google-photos/session', async (_req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Google Photos is not configured yet.' });
  }
  if (!hasGoogleToken()) {
    return res.status(401).json({ authUrl: createGoogleAuthUrl() });
  }

  try {
    const session = await googlePickerFetch('https://photospicker.googleapis.com/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const pickerUri = session.pickerUri?.endsWith('/autoclose')
      ? session.pickerUri
      : `${session.pickerUri}/autoclose`;
    return res.json({ sessionId: session.id, pickerUri });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unable to start Google Photos picker.' });
  }
});

app.get('/api/google-photos/session/:sessionId', async (req, res) => {
  try {
    const session = await googlePickerFetch(`https://photospicker.googleapis.com/v1/sessions/${req.params.sessionId}`);
    return res.json(session);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unable to check Google Photos picker.' });
  }
});

app.post('/api/google-photos/session/:sessionId/import', async (req, res) => {
  try {
    const items = await listGooglePickedItems(req.params.sessionId);
    const importedItems = await Promise.all(items.map(importGooglePhoto));
    await googlePickerFetch(`https://photospicker.googleapis.com/v1/sessions/${req.params.sessionId}`, {
      method: 'DELETE',
    });
    return res.json({ items: importedItems });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unable to import Google Photos.' });
  }
});

app.post('/api/preview', upload.array('photos', 30), async (req, res) => {
  await handlePrintRequest(req, res, { print: false });
});

app.post('/api/print', upload.array('photos', 30), async (req, res) => {
  await handlePrintRequest(req, res, { print: true });
});

async function handlePrintRequest(req, res, { print }) {
  const uploadedFiles = req.files || [];
  const googlePhotoIds = parseJsonArray(req.body.googlePhotoIds);
  if (!uploadedFiles.length && !googlePhotoIds.length) {
    return res.status(400).json({ error: 'Please choose at least one photo to print.' });
  }

  const requestedSizes = parseJsonArray(req.body.sizes);

  const localJobs = uploadedFiles.map((file, index) => {
    const sizeKey = requestedSizes[index] || '4x6';
    const size = PRINT_SIZES[sizeKey];
    return { file, sizeKey, size };
  });
  const googleJobs = googlePhotoIds.map((id, index) => {
    const googlePhoto = googlePhotos.get(id);
    const sizeKey = requestedSizes[localJobs.length + index] || '4x6';
    const size = PRINT_SIZES[sizeKey];
    return googlePhoto
      ? { file: { path: googlePhoto.path }, sizeKey, size, source: 'google', name: googlePhoto.name }
      : { file: null, sizeKey, size };
  });
  const jobs = [...localJobs, ...googleJobs];

  const invalidJob = jobs.find((job) => !job.file || !job.size);
  if (invalidJob) {
    await cleanupUploads(uploadedFiles);
    return res.status(400).json({ error: 'Please choose a valid print size for every photo.' });
  }

  try {
    await mkdir(PRINT_DIR, { recursive: true });
    const pages = await composePages(jobs);
    await cleanupUploads(uploadedFiles);

    if (print && !PRINT_DRY_RUN) {
      for (const page of pages) {
        await sendToPrinter(page.outputPath);
      }
    }

    return res.json({
      ok: true,
      dryRun: PRINT_DRY_RUN,
      pageCount: pages.length,
      imageCount: jobs.length,
      pages: pages.map((page) => ({
        previewUrl: `/prints/${path.basename(page.outputPath)}`,
        imageCount: page.items.length,
        items: page.items.map((placement) => ({
          index: placement.item.index,
          left: placement.left,
          top: placement.top,
          width: placement.width,
          height: placement.height,
        })),
      })),
      message: !print
        ? `Previewing ${jobs.length} photo${jobs.length === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}.`
        : PRINT_DRY_RUN
        ? `Prepared ${jobs.length} photo${jobs.length === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}. Set PRINT_DRY_RUN=false to print.`
        : `Sent ${pages.length} page${pages.length === 1 ? '' : 's'} to ${PRINTER_NAME || 'the default printer'}.`,
    });
  } catch (error) {
    await cleanupUploads(uploadedFiles);
    return res.status(500).json({ error: error.message || 'Unable to print photo.' });
  }
}

async function composePages(jobs) {
  const pageWidth = Math.round(PAGE.widthIn * DPI);
  const pageHeight = Math.round(PAGE.heightIn * DPI);
  const margin = Math.round(PAGE.marginIn * DPI);
  const gap = Math.round(PAGE.gapIn * DPI);
  const usableWidth = pageWidth - margin * 2;
  const usableHeight = pageHeight - margin * 2;
  const placements = [];
  const pages = [];

  const items = (await Promise.all(jobs.map(preparePrintItem)))
    .sort((a, b) => b.width * b.height - a.width * a.height);

  for (const item of items) {
    const candidates = [item].filter((candidate) => candidate.width <= usableWidth && candidate.height <= usableHeight);

    if (!candidates.length) {
      throw new Error(`${item.size.label} is too large for ${PAGE.label} paper.`);
    }

    const placement = placeItem(pages, candidates, usableWidth, usableHeight, gap);
    placements.push({ ...placement, item });
  }

  const outputPages = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageItems = placements
      .filter((placement) => placement.pageIndex === pageIndex)
      .map((placement) => ({
        ...placement,
        left: margin + placement.x,
        top: margin + placement.y,
      }));
    const outputPath = path.join(PRINT_DIR, `${crypto.randomUUID()}-page-${pageIndex + 1}.jpg`);
    const composites = await Promise.all(
      pageItems.map(async (placement) => {
        const image = await sharp(placement.item.file.path)
          .rotate()
          .resize(placement.width, placement.height, { fit: 'contain', background: '#ffffff' })
          .jpeg({ quality: 95 })
          .toBuffer();

        return {
          input: image,
          left: placement.left,
          top: placement.top,
        };
      }),
    );

    await sharp({
      create: {
        width: pageWidth,
        height: pageHeight,
        channels: 3,
        background: '#ffffff',
      },
    })
      .composite(composites)
      .jpeg({ quality: 95 })
      .withMetadata({ density: DPI })
      .toFile(outputPath);

    outputPages.push({ outputPath, items: pageItems });
  }

  return outputPages;
}

async function preparePrintItem(job, index) {
  const metadata = await sharp(job.file.path).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const swapsAxes = metadata.orientation >= 5 && metadata.orientation <= 8;
  const orientedWidth = swapsAxes ? height : width;
  const orientedHeight = swapsAxes ? width : height;
  const printWidthIn = Math.max(job.size.widthIn, job.size.heightIn);
  const printHeightIn = Math.min(job.size.widthIn, job.size.heightIn);
  const isLandscape = orientedWidth > orientedHeight;
  const isPortrait = orientedHeight > orientedWidth;
  const widthIn = isLandscape ? printWidthIn : isPortrait ? printHeightIn : job.size.widthIn;
  const heightIn = isLandscape ? printHeightIn : isPortrait ? printWidthIn : job.size.heightIn;

  return {
    ...job,
    index,
    width: Math.round(widthIn * DPI),
    height: Math.round(heightIn * DPI),
  };
}

function placeItem(pages, candidates, usableWidth, usableHeight, gap) {
  const rankedCandidates = [...candidates].sort((a, b) => b.width * b.height - a.width * a.height);

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    for (const candidate of rankedCandidates) {
      const placement = findPlacement(pages[pageIndex].items, candidate, usableWidth, usableHeight, gap);
      if (placement) {
        const placed = { pageIndex, ...candidate, ...placement };
        pages[pageIndex].items.push(placed);
        return placed;
      }
    }
  }

  const firstCandidate = rankedCandidates[0];
  const pageIndex = pages.length;
  const placed = { pageIndex, ...firstCandidate, x: 0, y: 0 };
  pages.push({ items: [placed] });
  return placed;
}

function findPlacement(items, candidate, usableWidth, usableHeight, gap) {
  const xs = [0];
  const ys = [0];

  for (const item of items) {
    xs.push(item.x + item.width + gap);
    ys.push(item.y + item.height + gap);
  }

  const sortedPositions = [];
  for (const y of ys) {
    for (const x of xs) {
      sortedPositions.push({ x, y });
    }
  }
  sortedPositions.sort((a, b) => a.y - b.y || a.x - b.x);

  return sortedPositions.find((position) => {
    const right = position.x + candidate.width;
    const bottom = position.y + candidate.height;
    if (right > usableWidth || bottom > usableHeight) {
      return false;
    }

    return items.every((item) => {
      return (
        right + gap <= item.x ||
        position.x >= item.x + item.width + gap ||
        bottom + gap <= item.y ||
        position.y >= item.y + item.height + gap
      );
    });
  });
}

function cleanupUploads(files) {
  return Promise.all(files.map((file) => rm(file.path, { force: true })));
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasGoogleToken() {
  return Boolean(googleToken?.access_token && Date.now() < googleToken.expiresAt - 60_000);
}

function createGoogleAuthUrl() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return '';
  }

  const state = createGoogleState();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: GOOGLE_PHOTOS_SCOPE,
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function createGoogleState() {
  const nonce = crypto.randomUUID();
  const signature = crypto
    .createHmac('sha256', GOOGLE_CLIENT_SECRET)
    .update(nonce)
    .digest('base64url');
  return `${nonce}.${signature}`;
}

function isValidGoogleState(state) {
  const [nonce, signature] = state.split('.');
  if (!nonce || !signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', GOOGLE_CLIENT_SECRET)
    .update(nonce)
    .digest('base64url');
  if (signature.length !== expectedSignature.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

async function exchangeGoogleCode(code) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const token = await response.json();
  if (!response.ok) {
    throw new Error(token.error_description || token.error || 'Google token exchange failed.');
  }
  return {
    ...token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
}

async function googlePickerFetch(url, options = {}) {
  if (!hasGoogleToken()) {
    throw new Error('Google Photos is not connected.');
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${googleToken.access_token}`,
    },
  });

  if (response.status === 204) {
    return {};
  }

  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error?.message || payload.error || 'Google Photos request failed.');
  }
  return payload;
}

async function listGooglePickedItems(sessionId) {
  const items = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({ sessionId });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    const page = await googlePickerFetch(`https://photospicker.googleapis.com/v1/mediaItems?${params.toString()}`);
    items.push(...(page.mediaItems || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  return items.filter((item) => item.type === 'PHOTO' && item.mediaFile?.baseUrl);
}

async function importGooglePhoto(item) {
  await mkdir(GOOGLE_PHOTOS_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const mediaFile = item.mediaFile;
  const extension = mediaFile.mimeType === 'image/png' ? 'png' : 'jpg';
  const filename = mediaFile.filename || `google-photo-${id}.${extension}`;
  const outputPath = path.join(GOOGLE_PHOTOS_DIR, `${id}.${extension}`);
  const downloadUrl = `${mediaFile.baseUrl}=d`;
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${googleToken.access_token}` },
  });

  if (!response.ok) {
    throw new Error(`Unable to download ${filename} from Google Photos.`);
  }

  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  const imported = {
    id,
    name: filename,
    path: outputPath,
    thumbnailUrl: `/google-photos/${path.basename(outputPath)}`,
  };
  googlePhotos.set(id, imported);
  return {
    id: imported.id,
    name: imported.name,
    thumbnailUrl: imported.thumbnailUrl,
  };
}

function sendToPrinter(filePath) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (PRINTER_NAME) {
      args.push('-d', PRINTER_NAME);
    }
    args.push(
      '-o',
      'media=Letter',
      '-o',
      'fit-to-page',
      filePath,
    );

    execFile('lp', args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

if (!existsSync(path.join(__dirname, 'uploads'))) {
  await mkdir(path.join(__dirname, 'uploads'), { recursive: true });
}

app.listen(PORT, HOST, () => {
  console.log(`Photo printer app running at http://localhost:${PORT}`);
  for (const address of getLanAddresses()) {
    console.log(`LAN access: http://${address}:${PORT}`);
  }
  console.log(PRINT_DRY_RUN ? 'Dry run mode is on.' : 'Printing is enabled.');
});

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((networkInterface) => {
      return networkInterface?.family === 'IPv4' && !networkInterface.internal;
    })
    .map((networkInterface) => networkInterface.address);
}
