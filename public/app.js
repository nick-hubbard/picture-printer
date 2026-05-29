const form = document.querySelector('#print-form');
const photoInput = document.querySelector('#photo');
const fileName = document.querySelector('#file-name');
const statusText = document.querySelector('#status');
const previewImage = document.querySelector('#preview-image');
const previewEmpty = document.querySelector('#preview-empty');
const googleButton = document.querySelector('#google-button');
const googleStatus = document.querySelector('#google-status');

fetch('/api/options')
  .then((response) => response.json())
  .then((options) => {
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
  const file = photoInput.files[0];
  fileName.textContent = file ? file.name : 'JPG, PNG, HEIC, or WebP';
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  statusText.textContent = 'Preparing photo...';

  try {
    const response = await fetch('/api/print', {
      method: 'POST',
      body: new FormData(form),
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Print failed.');
    }

    previewImage.src = `${result.previewUrl}?t=${Date.now()}`;
    previewImage.hidden = false;
    previewEmpty.hidden = true;
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
