const photoInput = document.querySelector('#photos');
const fileName = document.querySelector('#file-name');
const sizesInput = document.querySelector('#sizes');
const googlePhotoIdsInput = document.querySelector('#google-photo-ids');
const statusText = document.querySelector('#status');
const previewPages = document.querySelector('#preview-pages');
const previewEmpty = document.querySelector('#preview-empty');
const googleButton = document.querySelector('#google-button');
const googleDisconnectButton = document.querySelector('#google-disconnect');
const accountMenuButton = document.querySelector('#account-menu-button');
const accountMenu = document.querySelector('#account-menu');
const settingsMenuButton = document.querySelector('#settings-menu-button');
const mainView = document.querySelector('#main-view');
const settingsView = document.querySelector('#settings-view');
const settingsBackButton = document.querySelector('#settings-back-button');
const settingsForm = document.querySelector('#settings-form');
const defaultPrintSizeSelect = document.querySelector('#default-print-size');
const visiblePrintSizes = document.querySelector('#visible-print-sizes');
const appMode = document.querySelector('#app-mode');
const browserPrintButton = document.querySelector('#browser-print-button');
const downloadButton = document.querySelector('#download-button');
const progressOverlay = document.querySelector('#progress-overlay');
const progressStatus = document.querySelector('#progress-status');
const previewPicker = document.createElement('div');
const SETTINGS_KEY = 'photoPrinterSettings';
const DEFAULT_PRINT_SIZE = '3.5x5';
const DEFAULT_VISIBLE_PRINT_SIZES = ['3.5x5', '4x6'];

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
let hostedMode = false;
let settings = readSettings();
const PAGE_WIDTH = 2550;
const PAGE_HEIGHT = 3300;
const HOSTED_UPLOAD_MAX_EDGE = 1800;
const HOSTED_UPLOAD_JPEG_QUALITY = 0.78;

previewPicker.className = 'preview-picker';
previewPicker.hidden = true;
previewPicker.tabIndex = -1;
document.body.append(previewPicker);
accountMenuButton.hidden = false;
settings = normalizeSettings(settings);
saveSettings();
renderSettingsForm();

fetch('/api/options')
  .then((response) => response.json())
  .then((options) => {
    printSizes = options.sizes;
    settings = normalizeSettings(settings);
    saveSettings();
    renderSettingsForm();
    serverPrintingEnabled = Boolean(options.serverPrintingEnabled);
    hostedMode = Boolean(options.hosted);
    appMode.textContent = serverPrintingEnabled ? 'Local photo printer' : 'Hosted print layout';
    setStatus(
      serverPrintingEnabled
        ? `Ready to print to ${options.printerName}.`
        : 'Choose photos to preview printable pages.',
    );

    if (options.googlePhotosEnabled) {
      googleButton.disabled = false;
      setGoogleConnectedUi(Boolean(options.googlePhotosConnected));
    }
  })
  .catch(() => {
    setStatus('Unable to read printer settings.', true);
  });

photoInput.addEventListener('change', () => {
  const files = [...photoInput.files];
  if (!files.length) {
    return;
  }

  showProgress('Adding photos...');
  const previousLocalCount = localPhotos.length;
  localPhotos = [...localPhotos, ...files];
  selectedSizes = [
    ...selectedSizes.slice(0, previousLocalCount),
    ...files.map(() => settings.defaultPrintSize),
    ...selectedSizes.slice(previousLocalCount),
  ];
  photoInput.value = '';
  syncHiddenInputs();
  updateSelectedPhotoCount();
  updatePreview();
});

googleButton.addEventListener('click', async () => {
  googleButton.disabled = true;
  setStatus('Connecting to Google Photos...');

  try {
    const response = await fetch('/api/google-photos/session', { method: 'POST' });
    const result = await response.json();

    if (response.status === 401 && result.authUrl) {
      window.open(result.authUrl, 'google-auth', 'width=520,height=680');
      setStatus('After signing in, click Google Photos again.');
      return;
    }

    if (!response.ok) {
      throw new Error(result.error || 'Unable to open Google Photos.');
    }

    setGoogleConnectedUi(true);
    const pickerWindow = window.open(result.pickerUri, 'google-photos-picker', 'width=980,height=720');
    if (!pickerWindow) {
      throw new Error('Allow popups to choose Google Photos.');
    }
    setStatus('Choose photos in Google Photos, then click Done.');
    showProgress('Waiting for Google Photos...');
    const importedItems = await waitForGooglePhotos(result.sessionId, pickerWindow);
    addGooglePhotos(importedItems);
  } catch (error) {
    hideProgress();
    if (error.message === 'Google Photos selection cancelled.') {
      setGoogleConnectedUi(true);
    }
    setStatus(error.message, true);
  } finally {
    googleButton.disabled = false;
  }
});

googleDisconnectButton.addEventListener('click', async () => {
  googleDisconnectButton.disabled = true;
  closeAccountMenu();
  try {
    const response = await fetch('/auth/google/logout', { method: 'POST' });
    if (!response.ok) {
      throw new Error('Unable to sign out of Google Photos.');
    }
    googlePhotos = [];
    selectedSizes = getSelectedPhotos().map((_, index) => selectedSizes[index] || settings.defaultPrintSize);
    syncHiddenInputs();
    updateSelectedPhotoCount();
    setGoogleConnectedUi(false);
    setStatus('Signed out of Google Photos.');
    updatePreview();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    googleDisconnectButton.disabled = false;
  }
});

function setGoogleConnectedUi(connected) {
  accountMenuButton.hidden = false;
  googleDisconnectButton.hidden = !connected;
}

accountMenuButton.addEventListener('click', () => {
  const expanded = accountMenuButton.getAttribute('aria-expanded') === 'true';
  accountMenuButton.setAttribute('aria-expanded', String(!expanded));
  accountMenu.hidden = expanded;
});

settingsMenuButton.addEventListener('click', () => {
  closeAccountMenu();
  showSettingsView();
});

settingsBackButton.addEventListener('click', () => {
  showMainView();
});

settingsForm.addEventListener('change', (event) => {
  if (event.target === defaultPrintSizeSelect) {
    settings.defaultPrintSize = defaultPrintSizeSelect.value;
    if (!settings.visiblePrintSizes.includes(settings.defaultPrintSize)) {
      settings.visiblePrintSizes = [...settings.visiblePrintSizes, settings.defaultPrintSize];
    }
    saveSettings();
    renderSettingsForm();
    return;
  }

  if (!(event.target instanceof HTMLInputElement) || event.target.name !== 'visiblePrintSizes') {
    return;
  }

  const checkedValues = [...visiblePrintSizes.querySelectorAll('input[name="visiblePrintSizes"]:checked')]
    .map((input) => input.value);
  settings.visiblePrintSizes = checkedValues.length ? checkedValues : [settings.defaultPrintSize];

  if (!settings.visiblePrintSizes.includes(settings.defaultPrintSize)) {
    settings.defaultPrintSize = settings.visiblePrintSizes[0];
  }

  saveSettings();
  normalizeSelectedSizes();
  syncHiddenInputs();
  renderSettingsForm();
  if (getSelectedPhotos().length) {
    updatePreview();
  }
});

browserPrintButton.addEventListener('click', () => {
  if (!currentPages.length) {
    return;
  }

  const printWindow = window.open('', 'photo-print-pages');
  if (!printWindow) {
    setStatus('Allow popups to print the prepared pages.', true);
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


  setStatus('Google Photos connected. Opening picker...');
  googleButton.click();
});

document.addEventListener('click', (event) => {
  const target = event.target;
  if (
    target instanceof Node
    && !accountMenu.hidden
    && !accountMenu.contains(target)
    && !accountMenuButton.contains(target)
  ) {
    closeAccountMenu();
  }

  if (previewPicker.hidden) {
    return;
  }

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
  if (event.key === 'Escape') {
    closeAccountMenu();
  }

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

function closeAccountMenu() {
  accountMenu.hidden = true;
  accountMenuButton.setAttribute('aria-expanded', 'false');
}

function showSettingsView() {
  renderSettingsForm();
  mainView.hidden = true;
  settingsView.hidden = false;
  settingsBackButton.focus();
}

function showMainView() {
  settingsView.hidden = true;
  mainView.hidden = false;
}

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
    setStatus(
      serverPrintingEnabled
        ? 'Choose photos to preview the print pages.'
        : 'Choose photos to preview printable pages.',
    );

    return;
  }

  previewAbortController?.abort();
  previewAbortController = new AbortController();
  const requestId = ++previewRequestId;
  syncHiddenInputs();
  showProgress('Updating preview...');

  try {
    const response = await fetch('/api/preview', {
      method: 'POST',
      body: await buildPrintFormData(),
      signal: previewAbortController.signal,
    });
    const result = await readJsonResponse(response);

    if (requestId !== previewRequestId) {
      return;
    }

    if (!response.ok) {
      throw new Error(result.error || 'Preview failed.');
    }

    renderPreviewPages(result.pages);
    setStatus(result.message);

  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }
    setStatus(error.message, true);

  } finally {
    if (requestId === previewRequestId) {
      hideProgress();
    }
  }
}

function showProgress(message) {
  progressStatus.textContent = message;
  progressOverlay.hidden = false;
  document.body.setAttribute('aria-busy', 'true');
}

function hideProgress() {
  progressOverlay.hidden = true;
  progressStatus.textContent = '';
  document.body.removeAttribute('aria-busy');
}

function setStatus(message, isError = false) {
  if (!statusText) {
    return;
  }
  statusText.textContent = message || '';
  statusText.classList.toggle('is-error', isError);
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
  browserPrintButton.hidden = !hasPages;
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

  for (const size of getVisiblePrintSizes()) {
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
  selectedSizes = getSelectedPhotos().map((_, index) => selectedSizes[index] || settings.defaultPrintSize);
  syncHiddenInputs();
  updateSelectedPhotoCount();
  setGoogleConnectedUi(true);
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

async function buildPrintFormData() {
  syncHiddenInputs();
  const formData = new FormData();
  for (const file of localPhotos) {
    formData.append('photos', await prepareUploadFile(file));
  }
  formData.append('sizes', sizesInput.value);
  formData.append('googlePhotoIds', googlePhotoIdsInput.value);
  return formData;
}

async function prepareUploadFile(file) {
  if (!hostedMode || !file.type.startsWith('image/') || file.type === 'image/heic' || file.type === 'image/heif') {
    return file;
  }

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, HOSTED_UPLOAD_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale >= 1 && file.size < 1_500_000) {
      bitmap.close?.();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    const blob = await new Promise((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', HOSTED_UPLOAD_JPEG_QUALITY);
    });

    if (!blob) {
      return file;
    }

    return new File(
      [blob],
      `${file.name.replace(/\.[^.]+$/, '') || 'photo'}-hosted-preview.jpg`,
      { type: 'image/jpeg', lastModified: file.lastModified },
    );
  } catch {
    return file;
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    if (response.status === 413) {
      return { error: 'Those photos are too large for hosted preview. Try fewer photos at a time, or use smaller image files.' };
    }
    return { error: text || 'Preview failed.' };
  }
}

function syncHiddenInputs() {
  sizesInput.value = JSON.stringify(selectedSizes);
  googlePhotoIdsInput.value = JSON.stringify(googlePhotos.map((photo) => photo.id));
}

function readSettings() {
  try {
    const savedSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      defaultPrintSize: savedSettings.defaultPrintSize || DEFAULT_PRINT_SIZE,
      visiblePrintSizes: Array.isArray(savedSettings.visiblePrintSizes)
        ? savedSettings.visiblePrintSizes
        : DEFAULT_VISIBLE_PRINT_SIZES,
    };
  } catch {
    return {
      defaultPrintSize: DEFAULT_PRINT_SIZE,
      visiblePrintSizes: DEFAULT_VISIBLE_PRINT_SIZES,
    };
  }
}

function normalizeSettings(candidate) {
  const availableValues = new Set(printSizes.map((size) => size.value));
  const visiblePrintSizes = candidate.visiblePrintSizes.filter((value) => availableValues.has(value));
  const defaultPrintSize = availableValues.has(candidate.defaultPrintSize)
    ? candidate.defaultPrintSize
    : DEFAULT_PRINT_SIZE;
  const normalizedVisible = visiblePrintSizes.length
    ? visiblePrintSizes
    : DEFAULT_VISIBLE_PRINT_SIZES.filter((value) => availableValues.has(value));

  if (!normalizedVisible.includes(defaultPrintSize)) {
    normalizedVisible.unshift(defaultPrintSize);
  }

  return {
    defaultPrintSize,
    visiblePrintSizes: [...new Set(normalizedVisible)],
  };
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function getVisiblePrintSizes() {
  const visibleValues = new Set(settings.visiblePrintSizes);
  return printSizes.filter((size) => visibleValues.has(size.value));
}

function normalizeSelectedSizes() {
  const visibleValues = new Set(settings.visiblePrintSizes);
  selectedSizes = selectedSizes.map((size) => (visibleValues.has(size) ? size : settings.defaultPrintSize));
}

function renderSettingsForm() {
  defaultPrintSizeSelect.replaceChildren(...printSizes.map((size) => {
    const option = document.createElement('option');
    option.value = size.value;
    option.textContent = size.label;
    option.selected = size.value === settings.defaultPrintSize;
    return option;
  }));

  const visibleValues = new Set(settings.visiblePrintSizes);
  visiblePrintSizes.replaceChildren(...printSizes.map((size) => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    const text = document.createElement('span');
    label.className = 'settings-check';
    checkbox.type = 'checkbox';
    checkbox.name = 'visiblePrintSizes';
    checkbox.value = size.value;
    checkbox.checked = visibleValues.has(size.value);
    text.textContent = size.label;
    label.append(checkbox, text);
    return label;
  }));
}

function updateSelectedPhotoCount() {
  const photoCount = getSelectedPhotos().length;
  fileName.textContent = photoCount
    ? `${photoCount} photo${photoCount === 1 ? '' : 's'} selected`
    : 'JPG, PNG, HEIC, or WebP';
}

async function waitForGooglePhotos(sessionId, pickerWindow) {
  // Picker URL uses /autoclose, so the window closes as soon as the user clicks Done —
  // but Google's backend may take many seconds to mark mediaItemsSet=true, especially
  // for large selections and over higher-latency hosted environments. Keep polling for
  // a generous window after close before treating it as a true cancellation.
  const POST_CLOSE_GRACE_MS = 60_000;
  let closedSince = 0;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`/api/google-photos/session/${sessionId}?t=${Date.now()}`, {
      cache: 'no-store',
    });
    const session = await response.json();
    if (!response.ok) {
      throw new Error(session.error || 'Unable to check Google Photos.');
    }

    if (session.mediaItemsSet) {
      showProgress('Adding photos...');
      const importResponse = await fetch(`/api/google-photos/session/${sessionId}/import`, {
        method: 'POST',
      });
      const imported = await importResponse.json();
      if (!importResponse.ok) {
        throw new Error(imported.error || 'Unable to import Google Photos.');
      }
      return imported.items;
    }

    if (pickerWindow?.closed) {
      if (!closedSince) {
        closedSince = Date.now();
      } else if (Date.now() - closedSince >= POST_CLOSE_GRACE_MS) {
        throw new Error('Google Photos selection cancelled.');
      }
    } else {
      closedSince = 0;
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
