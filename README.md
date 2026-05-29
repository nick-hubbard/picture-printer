# Photo Printer

A tiny local web app for uploading a photo, choosing a print size, and sending the prepared image to a printer configured on the Mac.

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

## Print Sizes

The app prepares images at 300 DPI with center crop:

- `4x6`
- `5x7`
- `8x10`

## Google Photos

The UI includes a disabled Google Photos entry point. To finish that feature, create a Google Cloud OAuth client, request Google Photos Library API access, and add a server route that exchanges the selected media item for a temporary download URL before passing the image through the same print pipeline.
