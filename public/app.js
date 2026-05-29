const form = document.querySelector('#print-form');
const photoInput = document.querySelector('#photos');
const fileName = document.querySelector('#file-name');
const photoList = document.querySelector('#photo-list');
const sizesInput = document.querySelector('#sizes');
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
      googleStatus.textContent = 'Ready to connect';
    }
  })
  .catch(() => {
    statusText.textContent = 'Unable to read printer settings.';
  });

photoInput.addEventListener('change', () => {
  const files = [...photoInput.files];
  selectedSizes = files.map((_, index) => selectedSizes[index] || '4x6');
  sizesInput.value = JSON.stringify(selectedSizes);
  fileName.textContent = files.length
    ? `${files.length} photo${files.length === 1 ? '' : 's'} selected`
    : 'JPG, PNG, HEIC, or WebP';
  renderPhotoList(files);
  updatePreview();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  statusText.textContent = 'Preparing pages...';

  try {
    sizesInput.value = JSON.stringify(selectedSizes);
    const response = await fetch('/api/print', {
      method: 'POST',
      body: new FormData(form),
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

googleButton.addEventListener('click', () => {
  statusText.textContent = 'Google Photos needs OAuth credentials before it can open your library.';
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

function renderPhotoList(files) {
  photoList.replaceChildren(
    ...files.map((file, index) => {
      const row = document.createElement('div');
      row.className = 'photo-row';
      row.dataset.photoIndex = String(index);

      const name = document.createElement('span');
      name.className = 'photo-name';
      name.textContent = file.name;

      const select = document.createElement('select');
      select.setAttribute('aria-label', `Print size for ${file.name}`);
      for (const size of printSizes) {
        const option = document.createElement('option');
        option.value = size.value;
        option.textContent = size.label;
        option.selected = size.value === selectedSizes[index];
        select.append(option);
      }
      select.addEventListener('change', () => {
        selectedSizes[index] = select.value;
        sizesInput.value = JSON.stringify(selectedSizes);
        updatePreview();
      });

      row.append(name, select);
      return row;
    }),
  );
}

async function updatePreview() {
  const files = [...photoInput.files];
  if (!files.length) {
    previewPages.replaceChildren();
    previewEmpty.hidden = false;
    statusText.textContent = 'Preview mode is on. No printer jobs will be sent yet.';
    return;
  }

  previewAbortController?.abort();
  previewAbortController = new AbortController();
  const requestId = ++previewRequestId;
  sizesInput.value = JSON.stringify(selectedSizes);
  statusText.textContent = 'Updating preview...';

  try {
    const response = await fetch('/api/preview', {
      method: 'POST',
      body: new FormData(form),
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
    sizesInput.value = JSON.stringify(selectedSizes);
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
