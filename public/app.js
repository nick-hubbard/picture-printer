const form = document.querySelector('#print-form');
const photoInput = document.querySelector('#photos');
const fileName = document.querySelector('#file-name');
const sizesInput = document.querySelector('#sizes');
const googlePhotoIdsInput = document.querySelector('#google-photo-ids');
const statusText = document.querySelector('#status');
const previewPages = document.querySelector('#preview-pages');
const previewEmpty = document.querySelector('#preview-empty');
const googleButton = document.querySelector('#google-button');
const googleStatus = document.querySelector('#google-status');
const appMode = document.querySelector('#app-mode');
const submitButton = document.querySelector('#submit-button');
const browserPrintButton = document.querySelector('#browser-print-button');
const downloadButton = document.querySelector('#download-button');
const previewPicker = document.createElement('div');

let printSizes = [
  { value: '2x3', label: '2 x 3' },
  { value: '2x3.5', label: '2 x 3.5' },
  { value: '3x4', label: '3 x 4' },
  { value: '4x4', label: '4 x 4' },
  { value: '3.5x5', label: '3.5 x 5' },
  { value: '4x6', label: '4 x 6' },
  { value: '5x7', label: '5 x 7' },
];
let localPhotos = [];
let selectedSizes = [];
let googlePhotos = [];
let previewAbortController;
let previewRequestId = 0;
let selectedPreviewIndex = null;
let currentPages = [];
let serverPrintingEnabled = false;
const PAGE_WIDTH = 2550;
const PAGE_HEIGHT = 3300;

previewPicker.className = 'preview-picker';
previewPicker.hidden = true;
previewPicker.tabIndex = -1;
document.body.append(previewPicker);

fetch('/api/options')
  .then((response) => response.json())
  .then((options) => {
    printSizes = options.sizes;
    serverPrintingEnabled = Boolean(options.serverPrintingEnabled);
    appMode.textContent = serverPrintingEnabled ? 'Local photo printer' : 'Hosted print layout';
    submitButton.textContent = serverPrintingEnabled ? 'Print photos' : 'Prepare pages';
    statusText.textContent = serverPrintingEnabled
      ? `Ready to print to ${options.printerName}.`
      : 'Prepare printable pages, then print or download them from your browser.';

    if (options.googlePhotosEnabled) {
      googleButton.disabled = false;
      googleStatus.textContent = options.googlePhotosConnected ? 'Connected' : 'Ready to connect';
    }
  })
  .catch(() => {
    statusText.textContent = 'Unable to read printer settings.';
  });

photoInput.addEventListener('change', () => {
  const files = [...photoInput.files];
  const previousLocalCount = localPhotos.length;
  localPhotos = [...localPhotos, ...files];
  selectedSizes = [
    ...selectedSizes.slice(0, previousLocalCount),
    ...files.map(() => '4x6'),
    ...selectedSizes.slice(previousLocalCount),
  ];
  photoInput.value = '';
  syncHiddenInputs();
  updateSelectedPhotoCount();
  updatePreview();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  statusText.textContent = serverPrintingEnabled ? 'Printing pages...' : 'Preparing pages...';

  try {
    syncHiddenInputs();
    const response = await fetch('/api/print', {
      method: 'POST',
      body: buildPrintFormData(),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Print failed.');
    }

    renderPreviewPages(result.pages);
    statusText.textContent = result.message;
  } catch (error) {
    statusText.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

googleButton.addEventListener('click', async () => {
  googleButton.disabled = true;
  googleStatus.textContent = 'Opening picker...';
  statusText.textContent = 'Connecting to Google Photos...';

  try {
    const response = await fetch('/api/google-photos/session', { method: 'POST' });
    const result = await response.json();

    if (response.status === 401 && result.authUrl) {
      window.open(result.authUrl, 'google-auth', 'width=520,height=680');
      googleStatus.textContent = 'Finish sign in';
      statusText.textContent = 'After signing in, click Google Photos again.';
      return;
    }

    if (!response.ok) {
      throw new Error(result.error || 'Unable to open Google Photos.');
    }

    window.open(result.pickerUri, 'google-photos-picker', 'width=980,height=720');
    googleStatus.textContent = 'Choose photos';
    statusText.textContent = 'Choose photos in Google Photos, then click Done.';
    const importedItems = await waitForGooglePhotos(result.sessionId);
    addGooglePhotos(importedItems);
  } catch (error) {
    statusText.textContent = error.message;
  } finally {
    googleButton.disabled = false;
  }
});

browserPrintButton.addEventListener('click', () => {
  if (!currentPages.length) {
    return;
  }

  const printWindow = window.open('', 'photo-print-pages');
  if (!printWindow) {
    statusText.textContent = 'Allow popups to print the prepared pages.';
    return;
  }

  const pageImages = currentPages
    .map((page, index) => `<img src="${getPageImageUrl(page)}" alt="Prepared print page ${index + 1}">`)
    .join('');
  printWindow.document.write(`<!doctype html>
    <html>
      <head>
        <title>Prepared photo pages</title>
        <style>
          @page { size: Letter; margin: 0; }
          * { box-sizing: border-box; }
          body { margin: 0; }
          img { display: block; width: 8.5in; height: 11in; page-break-after: always; }
        </style>
      </head>
      <body>${pageImages}</body>
    </html>`);
  printWindow.document.close();
  printWindow.addEventListener('load', () => {
    printWindow.focus();
    printWindow.print();
  }, { once: true });
});

downloadButton?.addEventListener('click', () => {
  for (const [index, page] of currentPages.entries()) {
    const link = document.createElement('a');
    link.href = getPageImageUrl(page);
    link.download = `photo-page-${index + 1}.jpg`;
    document.body.append(link);
    link.click();
    link.remove();
  }
});

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== 'google-photos-connected') {
    return;
  }

  googleStatus.textContent = 'Connected';
  statusText.textContent = 'Google Photos connected. Opening picker...';
  googleButton.click();
});

document.addEventListener('click', (event) => {
  if (previewPicker.hidden) {
    return;
  }

  const target = event.target;
  if (target instanceof Node && previewPicker.contains(target)) {
    return;
  }

  const selectedHotspot = target instanceof Element
    ? target.closest('.preview-hotspot.is-selected')
    : null;
  if (selectedHotspot) {
    return;
  }

  hidePreviewPicker();
});

document.addEventListener('keydown', (event) => {
  if (!['Delete', 'Backspace'].includes(event.key) || selectedPreviewIndex === null) {
    return;
  }

  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
    return;
  }

  event.preventDefault();
  removePhoto(selectedPreviewIndex);
});

function hidePreviewPicker() {
  previewPicker.hidden = true;
  previewPicker.replaceChildren();
}

async function updatePreview() {
  const photos = getSelectedPhotos();
  if (!photos.length) {
    selectedPreviewIndex = null;
    currentPages = [];
    updatePreparedPageActions();
    previewPages.replaceChildren();
    previewEmpty.hidden = false;
    statusText.textContent = serverPrintingEnabled
      ? 'Choose photos to preview the print pages.'
      : 'Prepare printable pages, then print or download them from your browser.';
    return;
  }

  previewAbortController?.abort();
  previewAbortController = new AbortController();
  const requestId = ++previewRequestId;
  syncHiddenInputs();
  statusText.textContent = 'Updating preview...';

  try {
    const response = await fetch('/api/preview', {
      method: 'POST',
      body: buildPrintFormData(),
      signal: previewAbortController.signal,
    });
    const result = await response.json();

    if (requestId !== previewRequestId) {
      return;
    }

    if (!response.ok) {
      throw new Error(result.error || 'Preview failed.');
    }

    renderPreviewPages(result.pages);
    statusText.textContent = result.message;
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }
    statusText.textContent = error.message;
  }
}

function renderPreviewPages(pages) {
  currentPages = pages;
  previewPages.replaceChildren(
    ...pages.map((page, index) => {
      const figure = document.createElement('figure');
      const pagePreview = document.createElement('div');
      const image = document.createElement('img');
      const caption = document.createElement('figcaption');
      pagePreview.className = 'page-preview';
      image.src = getPageImageUrl(page, { cacheBust: true });
      image.alt = `Prepared print page ${index + 1}`;
      caption.textContent = `Page ${index + 1}: ${page.imageCount} photo${page.imageCount === 1 ? '' : 's'}`;
      pagePreview.append(image, ...page.items.map(createPreviewHotspot));
      figure.append(pagePreview, caption);
      return figure;
    }),
  );
  previewEmpty.hidden = true;
  updatePreparedPageActions();
}

function getPageImageUrl(page, { cacheBust = false } = {}) {
  if (page.previewDataUrl) {
    return page.previewDataUrl;
  }
  return cacheBust ? `${page.previewUrl}?t=${Date.now()}` : page.previewUrl;
}

function updatePreparedPageActions() {
  const hasPages = currentPages.length > 0;
  browserPrintButton.disabled = !hasPages;
  if (downloadButton) {
    downloadButton.disabled = !hasPages;
  }
}

function createPreviewHotspot(item) {
  const button = document.createElement('button');
  button.className = 'preview-hotspot';
  if (item.index === selectedPreviewIndex) {
    button.classList.add('is-selected');
  }
  button.type = 'button';
  button.style.left = `${(item.left / PAGE_WIDTH) * 100}%`;
  button.style.top = `${(item.top / PAGE_HEIGHT) * 100}%`;
  button.style.width = `${(item.width / PAGE_WIDTH) * 100}%`;
  button.style.height = `${(item.height / PAGE_HEIGHT) * 100}%`;
  button.dataset.photoIndex = String(item.index);
  button.setAttribute('aria-label', `Change size for photo ${item.index + 1}`);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    selectedPreviewIndex = item.index;
    showPreviewPicker(item.index, button);
    updateSelectedPreviewHotspot();
  });
  return button;
}

function updateSelectedPreviewHotspot() {
  for (const hotspot of previewPages.querySelectorAll('.preview-hotspot')) {
    hotspot.classList.toggle('is-selected', Number(hotspot.dataset.photoIndex) === selectedPreviewIndex);
  }
}

function showPreviewPicker(index, anchor) {
  previewPicker.replaceChildren();

  const header = document.createElement('div');
  const title = document.createElement('span');
  const closeButton = document.createElement('button');
  const label = document.createElement('label');
  const labelText = document.createElement('span');
  const select = document.createElement('select');
  const removeButton = document.createElement('button');
  header.className = 'preview-picker-header';
  title.textContent = 'Photo';
  closeButton.className = 'preview-picker-close';
  closeButton.type = 'button';
  closeButton.textContent = 'x';
  closeButton.setAttribute('aria-label', 'Close size picker');
  closeButton.addEventListener('click', hidePreviewPicker);
  labelText.textContent = 'Size';
  select.setAttribute('aria-label', `Preview size for photo ${index + 1}`);

  for (const size of printSizes) {
    const option = document.createElement('option');
    option.value = size.value;
    option.textContent = size.label;
    option.selected = size.value === selectedSizes[index];
    select.append(option);
  }

  select.addEventListener('change', () => {
    selectedSizes[index] = select.value;
    syncHiddenInputs();
    previewPicker.hidden = true;
    updatePreview();
  });

  header.append(title, closeButton);
  label.append(labelText, select);
  removeButton.className = 'preview-remove';
  removeButton.type = 'button';
  removeButton.textContent = 'Remove image';
  removeButton.addEventListener('click', () => {
    removePhoto(index);
  });

  previewPicker.append(header, label, removeButton);
  previewPicker.hidden = false;

  const anchorRect = anchor.getBoundingClientRect();
  const pickerRect = previewPicker.getBoundingClientRect();
  const left = Math.min(
    window.innerWidth - pickerRect.width - 12,
    Math.max(12, anchorRect.left + anchorRect.width / 2 - pickerRect.width / 2),
  );
  const top = Math.min(
    window.innerHeight - pickerRect.height - 12,
    Math.max(12, anchorRect.top + 12),
  );
  previewPicker.style.left = `${left}px`;
  previewPicker.style.top = `${top}px`;
  previewPicker.focus();
}

function getSelectedPhotos() {
  return [
    ...localPhotos.map((file) => ({ name: file.name, source: 'local' })),
    ...googlePhotos,
  ];
}

function addGooglePhotos(items) {
  googlePhotos = [...googlePhotos, ...items.map((item) => ({ ...item, source: 'google' }))];
  selectedSizes = getSelectedPhotos().map((_, index) => selectedSizes[index] || '4x6');
  syncHiddenInputs();
  updateSelectedPhotoCount();
  googleStatus.textContent = 'Connected';
  updatePreview();
}

function removePhoto(index) {
  hidePreviewPicker();

  if (index < localPhotos.length) {
    localPhotos.splice(index, 1);
  } else {
    googlePhotos.splice(index - localPhotos.length, 1);
  }

  selectedSizes.splice(index, 1);
  const photoCount = getSelectedPhotos().length;
  if (!photoCount || selectedPreviewIndex === index) {
    selectedPreviewIndex = null;
  } else if (selectedPreviewIndex !== null && selectedPreviewIndex > index) {
    selectedPreviewIndex -= 1;
  }
  syncHiddenInputs();
  updateSelectedPhotoCount();
  updatePreview();
}

function buildPrintFormData() {
  syncHiddenInputs();
  const formData = new FormData();
  for (const file of localPhotos) {
    formData.append('photos', file);
  }
  formData.append('sizes', sizesInput.value);
  formData.append('googlePhotoIds', googlePhotoIdsInput.value);
  return formData;
}

function syncHiddenInputs() {
  sizesInput.value = JSON.stringify(selectedSizes);
  googlePhotoIdsInput.value = JSON.stringify(googlePhotos.map((photo) => photo.id));
}

function updateSelectedPhotoCount() {
  const photoCount = getSelectedPhotos().length;
  fileName.textContent = photoCount
    ? `${photoCount} photo${photoCount === 1 ? '' : 's'} selected`
    : 'JPG, PNG, HEIC, or WebP';
}

async function waitForGooglePhotos(sessionId) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const response = await fetch(`/api/google-photos/session/${sessionId}`);
    const session = await response.json();
    if (!response.ok) {
      throw new Error(session.error || 'Unable to check Google Photos.');
    }

    if (session.mediaItemsSet) {
      const importResponse = await fetch(`/api/google-photos/session/${sessionId}/import`, {
        method: 'POST',
      });
      const imported = await importResponse.json();
      if (!importResponse.ok) {
        throw new Error(imported.error || 'Unable to import Google Photos.');
      }
      return imported.items;
    }

    const interval = parseDurationMs(session.pollingConfig?.pollInterval) || 2000;
    await new Promise((resolve) => window.setTimeout(resolve, interval));
  }

  throw new Error('Google Photos selection timed out.');
}

function parseDurationMs(duration) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(duration || '');
  return match ? Number(match[1]) * 1000 : 0;
}
