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
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

const PORT = Number(process.env.PORT || 3000);
const PRINT_DRY_RUN = process.env.PRINT_DRY_RUN !== 'false';
const PRINTER_NAME = process.env.PRINTER_NAME || '';
const PRINT_DIR = path.join(__dirname, 'prints');

const PRINT_SIZES = {
  '4x6': { label: '4 x 6', widthIn: 4, heightIn: 6 },
  '5x7': { label: '5 x 7', widthIn: 5, heightIn: 7 },
  '8x10': { label: '8 x 10', widthIn: 8, heightIn: 10 },
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

app.post('/api/print', upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Please choose a photo to print.' });
  }

  const selectedSize = PRINT_SIZES[req.body.size];
  if (!selectedSize) {
    await rm(req.file.path, { force: true });
    return res.status(400).json({ error: 'Please choose a valid print size.' });
  }

  await mkdir(PRINT_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const outputPath = path.join(PRINT_DIR, `${id}-${req.body.size}.jpg`);
  const dpi = 300;
  const widthPx = selectedSize.widthIn * dpi;
  const heightPx = selectedSize.heightIn * dpi;

  try {
    await sharp(req.file.path)
      .rotate()
      .resize(widthPx, heightPx, { fit: 'cover', position: 'center' })
      .jpeg({ quality: 95 })
      .withMetadata({ density: dpi })
      .toFile(outputPath);

    await rm(req.file.path, { force: true });

    if (!PRINT_DRY_RUN) {
      await sendToPrinter(outputPath, selectedSize);
    }

    return res.json({
      ok: true,
      dryRun: PRINT_DRY_RUN,
      previewUrl: `/prints/${path.basename(outputPath)}`,
      message: PRINT_DRY_RUN
        ? 'Preview created. Set PRINT_DRY_RUN=false to send photos to the printer.'
        : `Sent ${selectedSize.label} photo to ${PRINTER_NAME || 'the default printer'}.`,
    });
  } catch (error) {
    await rm(req.file.path, { force: true });
    return res.status(500).json({ error: error.message || 'Unable to print photo.' });
  }
});

app.post('/api/google-photos/print', express.json(), (_req, res) => {
  res.status(501).json({
    error: 'Google Photos printing is not configured yet. Add OAuth credentials and exchange a selected media item URL for a temporary download before calling /api/print.',
  });
});

function sendToPrinter(filePath, size) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (PRINTER_NAME) {
      args.push('-d', PRINTER_NAME);
    }
    args.push(
      '-o',
      `media=Custom.${size.widthIn}x${size.heightIn}in`,
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
