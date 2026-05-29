const form = document.querySelector('#print-form');
const photoInput = document.querySelector('#photos');
const fileName = document.querySelector('#file-name');
const photoList = document.querySelector('#photo-list');
const sizesInput = document.querySelector('#sizes');
const googlePhotoIdsInput = document.querySelector('#google-photo-ids');
const statusText = document.querySelector('#status');
const previewPages = document.querySelector('#preview-pages');
const previewEmpty = document.querySelector('#preview-empty');
const googleButton = document.querySelector('#google-button');
const googleStatus = document.querySelector('#google-status');
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
let selectedSizes = [];
let googlePhotos = [];
let previewAbortController;
let previewRequestId = 0;
const PAGE_WIDTH = 2550;
const PAGE_HEIGHT = 3300;

previewPicker.className = 'preview-picker';
previewPicker.hidden = true;
document.body.append(previewPicker);

fetch('/api/options')
  .then((response) => response.json())
  .then((options) => {
    printSizes = options.sizes;
    statusText.textContent = options.dryRun
      ? 'Preview mode is on. No printer jobs will be sent yet.'
      : `Ready to print to ${options.printerName}.`;

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
  selectedSizes = [...files, ...googlePhotos].map((_, index) => selectedSizes[index] || '4x6');
  syncHiddenInputs();
  fileName.textContent = files.length || googlePhotos.length
    ? `${files.length} photo${files.length === 1 ? '' : 's'} selected`
    : 'JPG, PNG, HEIC, or WebP';
  renderPhotoList(getSelectedPhotos());
  updatePreview();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  statusText.textContent = 'Preparing pages...';

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

document.addEventListener('click', (event) => {
  if (previewPicker.hidden) {
    return;
  }

  const target = event.target;
  if (target instanceof Node && (previewPicker.contains(target) || target.closest?.('.preview-hotspot'))) {
    return;
  }

  previewPicker.hidden = true;
});

function renderPhotoList(photos) {
  photoList.replaceChildren(
    ...photos.map((photo, index) => {
      const row = document.createElement('div');
      row.className = 'photo-row';
      row.dataset.photoIndex = String(index);

      const name = document.createElement('span');
      name.className = 'photo-name';
      name.textContent = photo.name;

      const select = document.createElement('select');
      select.setAttribute('aria-label', `Print size for ${photo.name}`);
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
        updatePreview();
      });

      row.append(name, select);
      return row;
    }),
  );
}

async function updatePreview() {
  const photos = getSelectedPhotos();
  if (!photos.length) {
    previewPages.replaceChildren();
    previewEmpty.hidden = false;
    statusText.textContent = 'Preview mode is on. No printer jobs will be sent yet.';
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
  previewPages.replaceChildren(
    ...pages.map((page, index) => {
      const figure = document.createElement('figure');
      const pagePreview = document.createElement('div');
      const image = document.createElement('img');
      const caption = document.createElement('figcaption');
      pagePreview.className = 'page-preview';
      image.src = `${page.previewUrl}?t=${Date.now()}`;
      image.alt = `Prepared print page ${index + 1}`;
      caption.textContent = `Page ${index + 1}: ${page.imageCount} photo${page.imageCount === 1 ? '' : 's'}`;
      pagePreview.append(image, ...page.items.map(createPreviewHotspot));
      figure.append(pagePreview, caption);
      return figure;
    }),
  );
  previewEmpty.hidden = true;
}

function createPreviewHotspot(item) {
  const button = document.createElement('button');
  button.className = 'preview-hotspot';
  button.type = 'button';
  button.style.left = `${(item.left / PAGE_WIDTH) * 100}%`;
  button.style.top = `${(item.top / PAGE_HEIGHT) * 100}%`;
  button.style.width = `${(item.width / PAGE_WIDTH) * 100}%`;
  button.style.height = `${(item.height / PAGE_HEIGHT) * 100}%`;
  button.setAttribute('aria-label', `Change size for photo ${item.index + 1}`);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    focusPhotoSize(item.index);
    showPreviewPicker(item.index, button);
  });
  return button;
}

function focusPhotoSize(index) {
  const row = photoList.querySelector(`[data-photo-index="${index}"]`);
  const select = row?.querySelector('select');
  if (!row || !select) {
    return;
  }

  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  select.focus();
  row.classList.remove('is-highlighted');
  window.requestAnimationFrame(() => {
    row.classList.add('is-highlighted');
    window.setTimeout(() => row.classList.remove('is-highlighted'), 1400);
  });
}

function showPreviewPicker(index, anchor) {
  previewPicker.replaceChildren();

  const label = document.createElement('label');
  const labelText = document.createElement('span');
  const select = document.createElement('select');
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
    const rowSelect = photoList.querySelector(`[data-photo-index="${index}"] select`);
    if (rowSelect) {
      rowSelect.value = select.value;
    }
    previewPicker.hidden = true;
    updatePreview();
  });

  label.append(labelText, select);
  previewPicker.append(label);
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
  select.focus();
}

function getSelectedPhotos() {
  return [
    ...[...photoInput.files].map((file) => ({ name: file.name, source: 'local' })),
    ...googlePhotos,
  ];
}

function addGooglePhotos(items) {
  googlePhotos = [...googlePhotos, ...items.map((item) => ({ ...item, source: 'google' }))];
  selectedSizes = getSelectedPhotos().map((_, index) => selectedSizes[index] || '4x6');
  syncHiddenInputs();
  fileName.textContent = `${getSelectedPhotos().length} photo${getSelectedPhotos().length === 1 ? '' : 's'} selected`;
  googleStatus.textContent = 'Connected';
  renderPhotoList(getSelectedPhotos());
  updatePreview();
}

function buildPrintFormData() {
  syncHiddenInputs();
  const formData = new FormData();
  for (const file of photoInput.files) {
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
