# Photo Printer

A tiny local web app for uploading photos, choosing a print size for each one, and sending prepared pages to a printer configured on the Mac.

## Run

```sh
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

By default the app runs in preview mode and does not send printer jobs. To enable printing, edit `.env`:

```sh
PRINT_DRY_RUN=false
PRINTER_NAME=
```

Leave `PRINTER_NAME` blank to use the system default printer, or set it to a printer name from:

```sh
lpstat -p -d
```

## Batch Printing

The app prepares a live Letter-size page preview at 300 DPI, center-crops each photo to its selected size, and packs multiple photos onto a page when they fit. Larger photos are placed first to reduce paper waste.

Available photo sizes:

- `2x3`
- `2x3.5`
- `3x4`
- `4x4`
- `3.5x5`
- `4x6`
- `5x7`

## Google Photos

The UI includes a disabled Google Photos entry point. To finish that feature, create a Google Cloud OAuth client, request Google Photos Library API access, and add a server route that exchanges the selected media item for a temporary download URL before passing the image through the same print pipeline.
