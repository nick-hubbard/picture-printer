import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

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
const PRINT_DRY_RUN = process.env.PRINT_DRY_RUN !== 'false';
const PRINTER_NAME = process.env.PRINTER_NAME || '';
const PRINT_DIR = path.join(__dirname, 'prints');
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

app.get('/api/options', (_req, res) => {
  res.json({
    sizes: Object.entries(PRINT_SIZES).map(([value, size]) => ({ value, label: size.label })),
    dryRun: PRINT_DRY_RUN,
    printerName: PRINTER_NAME || 'System default printer',
    googlePhotosEnabled: Boolean(process.env.GOOGLE_CLIENT_ID),
  });
});

app.post('/api/preview', upload.array('photos', 30), async (req, res) => {
  await handlePrintRequest(req, res, { print: false });
});

app.post('/api/print', upload.array('photos', 30), async (req, res) => {
  await handlePrintRequest(req, res, { print: true });
});

async function handlePrintRequest(req, res, { print }) {
  if (!req.files?.length) {
    return res.status(400).json({ error: 'Please choose at least one photo to print.' });
  }

  let requestedSizes;
  try {
    requestedSizes = JSON.parse(req.body.sizes || '[]');
  } catch {
    requestedSizes = [];
  }

  const jobs = req.files.map((file, index) => {
    const sizeKey = requestedSizes[index] || '4x6';
    const size = PRINT_SIZES[sizeKey];
    return { file, sizeKey, size };
  });

  const invalidJob = jobs.find((job) => !job.size);
  if (invalidJob) {
    await cleanupUploads(req.files);
    return res.status(400).json({ error: 'Please choose a valid print size for every photo.' });
  }

  try {
    await mkdir(PRINT_DIR, { recursive: true });
    const pages = await composePages(jobs);
    await cleanupUploads(req.files);

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
    await cleanupUploads(req.files);
    return res.status(500).json({ error: error.message || 'Unable to print photo.' });
  }
}

app.post('/api/google-photos/print', express.json(), (_req, res) => {
  res.status(501).json({
    error: 'Google Photos printing is not configured yet. Add OAuth credentials and exchange a selected media item URL for a temporary download before calling /api/print.',
  });
});

async function composePages(jobs) {
  const pageWidth = Math.round(PAGE.widthIn * DPI);
  const pageHeight = Math.round(PAGE.heightIn * DPI);
  const margin = Math.round(PAGE.marginIn * DPI);
  const gap = Math.round(PAGE.gapIn * DPI);
  const usableWidth = pageWidth - margin * 2;
  const usableHeight = pageHeight - margin * 2;
  const placements = [];
  const pages = [];

  const items = jobs
    .map((job, index) => ({
      ...job,
      index,
      width: Math.round(job.size.widthIn * DPI),
      height: Math.round(job.size.heightIn * DPI),
    }))
    .sort((a, b) => b.width * b.height - a.width * a.height);

  for (const item of items) {
    const candidates = [
      { ...item, rotated: false },
      { ...item, width: item.height, height: item.width, rotated: true },
    ].filter((candidate) => candidate.width <= usableWidth && candidate.height <= usableHeight);

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
          .resize(placement.width, placement.height, { fit: 'cover', position: 'center' })
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

app.listen(PORT, () => {
  console.log(`Photo printer app running at http://localhost:${PORT}`);
  console.log(PRINT_DRY_RUN ? 'Dry run mode is on.' : 'Printing is enabled.');
});
