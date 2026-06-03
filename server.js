import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', true);
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = process.env.DATA_DIR || (IS_VERCEL ? path.join(os.tmpdir(), 'photo-printing') : __dirname);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PRINT_DIR = path.join(DATA_DIR, 'prints');
const GOOGLE_PHOTOS_DIR = path.join(DATA_DIR, 'google-photos');
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 25 * 1024 * 1024, files: 30 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PRINT_DRY_RUN = process.env.PRINT_DRY_RUN !== 'false';
const SERVER_PRINTING_ENABLED = !IS_VERCEL && !PRINT_DRY_RUN;
const PRINTER_NAME = process.env.PRINTER_NAME || '';
const GOOGLE_TOKEN_PATH = path.join(GOOGLE_PHOTOS_DIR, '.google-token.json');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const GOOGLE_PHOTOS_SCOPE = 'openid email https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const SESSION_SECRET = process.env.SESSION_SECRET || GOOGLE_CLIENT_SECRET;
const TOKEN_COOKIE = 'gphotos_token';
const TOKEN_COOKIE_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const TEMP_FILE_MAX_AGE_MS = Number(process.env.TEMP_FILE_MAX_AGE_MS || (IS_VERCEL ? 5 * 60 * 1000 : 60 * 60 * 1000));
const GOOGLE_PHOTO_DOWNLOAD_SIZE = Number(process.env.GOOGLE_PHOTO_DOWNLOAD_SIZE || 2400);
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
const DEFAULT_PRINT_SIZE = '3.5x5';

app.use(express.static(path.join(__dirname, 'public')));
app.use('/prints', express.static(PRINT_DIR));
app.use('/google-photos', express.static(GOOGLE_PHOTOS_DIR));

app.get('/api/options', (req, res) => {
  res.json({
    sizes: Object.entries(PRINT_SIZES).map(([value, size]) => ({ value, label: size.label })),
    dryRun: PRINT_DRY_RUN,
    hosted: IS_VERCEL,
    serverPrintingEnabled: SERVER_PRINTING_ENABLED,
    printerName: PRINTER_NAME || 'System default printer',
    googlePhotosEnabled: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    googlePhotosConnected: hasUsableToken(readStoredGoogleToken(req)),
  });
});

app.get('/auth/google', (req, res) => {
  const authUrl = createGoogleAuthUrl(req);
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
    const token = await exchangeGoogleCode(String(code), getGoogleRedirectUri(req));
    await saveGoogleToken(token);
    writeTokenCookie(res, req, token);
    console.log(`Google Photos connected with redirect URI: ${getGoogleRedirectUri(req)}`);
    return res.send('<script>window.opener?.postMessage({ type: "google-photos-connected" }, window.location.origin); window.close();</script><p>Google Photos connected. You can close this window.</p>');
  } catch (exchangeError) {
    console.error('Google authorization callback failed:', exchangeError);
    return res.status(500).send(exchangeError.message || 'Unable to connect Google Photos.');
  }
});

app.post('/auth/google/logout', async (req, res) => {
  await clearSavedGoogleToken();
  clearTokenCookie(res, req);
  return res.json({ ok: true });
});

app.get('/api/google-photos/status', (req, res) => {
  res.json({
    configured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    connected: hasUsableToken(readStoredGoogleToken(req)),
  });
});

app.post('/api/google-photos/session', async (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Google Photos is not configured yet.' });
  }
  const token = await ensureFreshToken(req, res);
  if (!token) {
    return res.status(401).json({ authUrl: createGoogleAuthUrl(req) });
  }

  try {
    const session = await googlePickerFetch('https://photospicker.googleapis.com/v1/sessions', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const pickerUri = buildPickerUri(session.pickerUri, token.email);
    return res.json({ sessionId: session.id, pickerUri });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unable to start Google Photos picker.' });
  }
});

app.get('/api/google-photos/session/:sessionId', async (req, res) => {
  const token = await ensureFreshToken(req, res);
  if (!token) {
    return res.status(401).json({ error: 'Google Photos is not connected.' });
  }
  try {
    const session = await googlePickerFetch(`https://photospicker.googleapis.com/v1/sessions/${req.params.sessionId}`, token);
    return res.json(session);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Unable to check Google Photos picker.' });
  }
});

app.post('/api/google-photos/session/:sessionId/import', async (req, res) => {
  const token = await ensureFreshToken(req, res);
  if (!token) {
    return res.status(401).json({ error: 'Google Photos is not connected.' });
  }
  try {
    await cleanupTempFiles();
    const items = await listGooglePickedItems(req.params.sessionId, token);
    const importedItems = await Promise.all(items.map((item) => importGooglePhoto(item, token)));
    await googlePickerFetch(`https://photospicker.googleapis.com/v1/sessions/${req.params.sessionId}`, token, {
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
  await cleanupTempFiles();
  const uploadedFiles = req.files || [];
  const googlePhotoIds = parseJsonArray(req.body.googlePhotoIds);
  if (!uploadedFiles.length && !googlePhotoIds.length) {
    return res.status(400).json({ error: 'Please choose at least one photo to print.' });
  }

  const requestedSizes = parseJsonArray(req.body.sizes);

  const localJobs = uploadedFiles.map((file, index) => {
    const sizeKey = requestedSizes[index] || DEFAULT_PRINT_SIZE;
    const size = PRINT_SIZES[sizeKey];
    return { file, sizeKey, size };
  });
  const googleJobs = googlePhotoIds.map((id, index) => {
    const googlePhoto = googlePhotos.get(id);
    const sizeKey = requestedSizes[localJobs.length + index] || DEFAULT_PRINT_SIZE;
    const size = PRINT_SIZES[sizeKey];
    return googlePhoto
      ? { file: { path: googlePhoto.path }, sizeKey, size, source: 'google', name: googlePhoto.name, googleId: id }
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

    if (print && SERVER_PRINTING_ENABLED) {
      for (const page of pages) {
        await sendToPrinter(page.outputPath);
      }
    }

    const serializedPages = await Promise.all(pages.map(serializePage));
    if (IS_VERCEL) {
      await Promise.all(pages.map((page) => rm(page.outputPath, { force: true })));
    }

    return res.json({
      ok: true,
      dryRun: PRINT_DRY_RUN,
      hosted: IS_VERCEL,
      serverPrintingEnabled: SERVER_PRINTING_ENABLED,
      pageCount: pages.length,
      imageCount: jobs.length,
      pages: serializedPages,
      message: !print
        ? `Previewing ${jobs.length} photo${jobs.length === 1 ? '' : 's'} on ${pages.length} page${pages.length === 1 ? '' : 's'}.`
        : !SERVER_PRINTING_ENABLED
        ? `Prepared ${jobs.length} photo${jobs.length === 1 ? '' : 's'} on ${pages.length} printable page${pages.length === 1 ? '' : 's'}. Use your browser to print or download.`
        : `Sent ${pages.length} page${pages.length === 1 ? '' : 's'} to ${PRINTER_NAME || 'the default printer'}.`,
    });
  } catch (error) {
    await cleanupUploads(uploadedFiles);
    return res.status(500).json({ error: error.message || 'Unable to print photo.' });
  }
}

async function serializePage(page) {
  return {
    previewUrl: `/prints/${path.basename(page.outputPath)}`,
    previewDataUrl: IS_VERCEL ? await fileToDataUrl(page.outputPath) : undefined,
    imageCount: page.items.length,
    items: page.items.map((placement) => ({
      index: placement.item.index,
      left: placement.left,
      top: placement.top,
      width: placement.width,
      height: placement.height,
    })),
  };
}

async function fileToDataUrl(filePath) {
  const image = await readFile(filePath);
  return `data:image/jpeg;base64,${image.toString('base64')}`;
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

async function cleanupTempFiles() {
  const cutoff = Date.now() - TEMP_FILE_MAX_AGE_MS;
  await Promise.all([
    cleanupOldFiles(UPLOAD_DIR, cutoff),
    cleanupOldFiles(PRINT_DIR, cutoff),
    cleanupOldFiles(GOOGLE_PHOTOS_DIR, cutoff),
  ]);

  for (const [id, photo] of googlePhotos) {
    if (photo.createdAt < cutoff || !existsSync(photo.path)) {
      googlePhotos.delete(id);
    }
  }
}

async function cleanupOldFiles(dir, cutoff) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .filter((entry) => path.join(dir, entry.name) !== GOOGLE_TOKEN_PATH)
      .map(async (entry) => {
        const filePath = path.join(dir, entry.name);
        try {
          const fileStat = await stat(filePath);
          if (fileStat.mtimeMs < cutoff) {
            await rm(filePath, { force: true });
          }
        } catch {
          // Another request may have already removed this temp file.
        }
      }),
  );
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isAccessTokenLive(token) {
  return Boolean(token?.access_token && Date.now() < token.expiresAt - 60_000);
}

function hasUsableToken(token) {
  return Boolean(token && (isAccessTokenLive(token) || token.refresh_token));
}

function getSessionKey() {
  if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET (or GOOGLE_CLIENT_SECRET) must be set to encrypt sessions.');
  }
  return crypto.createHash('sha256').update(SESSION_SECRET).digest();
}

function encryptToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSessionKey(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(token), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, data]).toString('base64url');
}

function decryptToken(value) {
  try {
    const buf = Buffer.from(value, 'base64url');
    if (buf.length < 28) return null;
    const iv = buf.subarray(0, 12);
    const authTag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getSessionKey(), iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return JSON.parse(plain);
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function readTokenCookie(req) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[TOKEN_COOKIE];
  if (!raw) return null;
  return decryptToken(raw);
}

function readStoredGoogleToken(req) {
  return readTokenCookie(req) || googleToken || null;
}

function isHttpsRequest(req) {
  return req.protocol === 'https' || req.secure || IS_VERCEL;
}

function writeTokenCookie(res, req, token) {
  const value = encryptToken(token);
  res.append(
    'Set-Cookie',
    [
      `${TOKEN_COOKIE}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(TOKEN_COOKIE_MAX_AGE_MS / 1000)}`,
      isHttpsRequest(req) ? 'Secure' : null,
    ]
      .filter(Boolean)
      .join('; '),
  );
}

function clearTokenCookie(res, req) {
  res.append(
    'Set-Cookie',
    [
      `${TOKEN_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
      isHttpsRequest(req) ? 'Secure' : null,
    ]
      .filter(Boolean)
      .join('; '),
  );
}

async function loadGoogleToken() {
  try {
    const saved = JSON.parse(await readFile(GOOGLE_TOKEN_PATH, 'utf8'));
    googleToken = saved;
  } catch {
    googleToken = null;
  }
}

async function saveGoogleToken(token) {
  googleToken = token;
  await mkdir(GOOGLE_PHOTOS_DIR, { recursive: true });
  await writeFile(GOOGLE_TOKEN_PATH, JSON.stringify(token, null, 2));
}

async function clearSavedGoogleToken() {
  googleToken = null;
  try {
    await rm(GOOGLE_TOKEN_PATH, { force: true });
  } catch {
    // Token storage is best-effort; clearing the in-memory token is enough for this process.
  }
}

async function refreshAccessToken(stored) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: stored.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error_description || payload.error || 'Google token refresh failed.');
    error.code = payload.error || 'refresh_failed';
    throw error;
  }
  return {
    ...payload,
    email: extractEmailFromIdToken(payload.id_token) || stored.email || null,
    refresh_token: payload.refresh_token || stored.refresh_token,
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
  };
}

async function ensureFreshToken(req, res) {
  const stored = readStoredGoogleToken(req);
  if (!stored) return null;
  if (isAccessTokenLive(stored)) {
    if (!readTokenCookie(req)) {
      writeTokenCookie(res, req, stored);
    }
    return stored;
  }
  if (!stored.refresh_token) {
    await clearSavedGoogleToken();
    clearTokenCookie(res, req);
    return null;
  }
  try {
    const refreshed = await refreshAccessToken(stored);
    await saveGoogleToken(refreshed);
    writeTokenCookie(res, req, refreshed);
    return refreshed;
  } catch (error) {
    console.error('Failed to refresh Google Photos token:', error.message);
    await clearSavedGoogleToken();
    clearTokenCookie(res, req);
    return null;
  }
}

function createGoogleAuthUrl(req) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return '';
  }

  const state = createGoogleState();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: getGoogleRedirectUri(req),
    response_type: 'code',
    scope: GOOGLE_PHOTOS_SCOPE,
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  const previousEmail = readStoredGoogleToken(req)?.email;
  if (previousEmail) {
    params.set('login_hint', previousEmail);
  }
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function buildPickerUri(rawUri, email) {
  if (!rawUri) return rawUri;
  let url = rawUri.endsWith('/autoclose') ? rawUri : `${rawUri}/autoclose`;
  if (email) {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}authuser=${encodeURIComponent(email)}`;
  }
  return url;
}

function getGoogleRedirectUri(req) {
  if (GOOGLE_REDIRECT_URI) {
    return GOOGLE_REDIRECT_URI;
  }
  return `${req.protocol}://${req.get('host')}/auth/google/callback`;
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

async function exchangeGoogleCode(code, redirectUri) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const token = await response.json();
  if (!response.ok) {
    throw new Error(token.error_description || token.error || 'Google token exchange failed.');
  }
  return {
    ...token,
    email: extractEmailFromIdToken(token.id_token),
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
  };
}

function extractEmailFromIdToken(idToken) {
  if (!idToken) return null;
  try {
    const payloadB64 = idToken.split('.')[1];
    if (!payloadB64) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    return payload.email || null;
  } catch {
    return null;
  }
}

async function googlePickerFetch(url, token, options = {}) {
  if (!token?.access_token) {
    throw new Error('Google Photos is not connected.');
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token.access_token}`,
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

async function listGooglePickedItems(sessionId, token) {
  const items = [];
  let pageToken = '';

  do {
    const params = new URLSearchParams({ sessionId });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    const page = await googlePickerFetch(`https://photospicker.googleapis.com/v1/mediaItems?${params.toString()}`, token);
    items.push(...(page.mediaItems || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);

  return items.filter((item) => item.type === 'PHOTO' && item.mediaFile?.baseUrl);
}

async function importGooglePhoto(item, token) {
  await mkdir(GOOGLE_PHOTOS_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const mediaFile = item.mediaFile;
  const extension = mediaFile.mimeType === 'image/png' ? 'png' : 'jpg';
  const filename = mediaFile.filename || `google-photo-${id}.${extension}`;
  const outputPath = path.join(GOOGLE_PHOTOS_DIR, `${id}.${extension}`);
  const downloadUrl = `${mediaFile.baseUrl}=w${GOOGLE_PHOTO_DOWNLOAD_SIZE}-h${GOOGLE_PHOTO_DOWNLOAD_SIZE}`;
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });

  if (!response.ok) {
    throw new Error(`Unable to download ${filename} from Google Photos.`);
  }

  await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  const imported = {
    id,
    name: filename,
    path: outputPath,
    createdAt: Date.now(),
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

if (!existsSync(UPLOAD_DIR)) {
  await mkdir(UPLOAD_DIR, { recursive: true });
}
await mkdir(PRINT_DIR, { recursive: true });
await mkdir(GOOGLE_PHOTOS_DIR, { recursive: true });
await loadGoogleToken();

if (!IS_VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`Photo printer app running at http://localhost:${PORT}`);
    for (const address of getLanAddresses()) {
      console.log(`LAN access: http://${address}:${PORT}`);
    }
    console.log(SERVER_PRINTING_ENABLED ? 'Printing is enabled.' : 'Hosted/preview mode is on.');
  });
}

export default app;

function getLanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((networkInterface) => {
      return networkInterface?.family === 'IPv4' && !networkInterface.internal;
    })
    .map((networkInterface) => networkInterface.address);
}
