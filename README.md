# Photo Printer

A tiny local web app for uploading photos, choosing a print size for each one, and sending prepared pages to a printer configured on the Mac.

## Run

```sh
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

To open the app from another device on the same network, keep `HOST=0.0.0.0` in `.env`, restart the app, and use one of the `LAN access` URLs printed in the terminal.

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

The app prepares a live Letter-size page preview at 300 DPI, preserves each photo's orientation, and fits the whole image inside the selected print size with white padding when needed. For example, a landscape photo printed as `4x6` is prepared as `6x4`. Larger photos are placed first to reduce paper waste.

Available photo sizes:

- `2x3`
- `2x3.5`
- `3x4`
- `4x4`
- `3.5x5`
- `4x6`
- `5x7`

## Google Photos

The Google Photos button uses the Google Photos Picker API, which lets users explicitly choose the photos they want to share with this local app.

1. In Google Cloud, enable the Google Photos Picker API.
2. Create an OAuth Web application client.
3. Add `http://localhost:3000/auth/google/callback` as an authorized redirect URI.
4. Add the credentials to `.env`:

```sh
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
```

Restart the app after changing `.env`.
