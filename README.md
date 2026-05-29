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

## Run With Docker And HTTPS

Docker runs the Node app behind an nginx HTTPS reverse proxy. This lets another computer on the same network open the app at `https://HOST_OR_IP`.

1. Copy the environment file if needed:

```sh
cp .env.example .env
```

2. Create a local TLS certificate. Replace `192.168.1.25` with the Docker host computer's LAN IP or DNS name:

```sh
mkdir -p certs
openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
  -keyout certs/server.key \
  -out certs/server.crt \
  -subj "/CN=192.168.1.25" \
  -addext "subjectAltName=IP:192.168.1.25,DNS:localhost"
```

3. Start the containers:

```sh
docker compose up --build
```

Open `https://192.168.1.25` from another computer. Because this is a self-signed certificate, browsers will show a trust warning unless you install `certs/server.crt` as a trusted certificate on the client device.

Generated files are stored in Docker volumes named `photo-printing_uploads`, `photo-printing_prints`, and `photo-printing_google-photos`.

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

When running through Docker HTTPS from another computer, also add the HTTPS callback URL to the Google OAuth client and set it in `.env`:

```sh
GOOGLE_REDIRECT_URI=https://192.168.1.25/auth/google/callback
```
