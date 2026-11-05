// Configuración del worker de PDF.js (Licencia Apache 2.0)
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

const { PDFDocument } = window.PDFLib;

// ==================== CONFIGURACIÓN DE NIVELES DE COMPRESIÓN ====================
const COMPRESSION_PRESETS = {
  none: {
    label: 'Sin compresión (Original)',
    scale: null,
    quality: null,
  },
  low: {
    label: 'Compresión Baja (Alta calidad · 150 DPI)',
    scale: 1.45,
    quality: 0.78,
  },
  medium: {
    label: 'Compresión Media (Equilibrada · 115 DPI)',
    scale: 1.12,
    quality: 0.58,
  },
  high: {
    label: 'Compresión Alta (Máximo ahorro · 85 DPI)',
    scale: 0.85,
    quality: 0.38,
  },
};

// ==================== UTILIDADES ====================
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function showStatus(title, detail = 'Por favor espera...', progress = 15) {
  const overlay = document.getElementById('status-overlay');
  document.getElementById('status-title').textContent = title;
  document.getElementById('status-detail').textContent = detail;
  document.getElementById('status-progress').style.width = `${Math.min(100, Math.max(0, progress))}%`;
  overlay.classList.remove('hidden');
}

function hideStatus() {
  document.getElementById('status-overlay').classList.add('hidden');
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 4000);
}

function downloadBlob(bytesOrBlob, filename, mimeType = 'application/pdf') {
  const blob = bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function renderCompressionSummaryBanner(bannerEl, originalBytes, finalBytes, levelKey) {
  if (!bannerEl) return;
  const preset = COMPRESSION_PRESETS[levelKey] || COMPRESSION_PRESETS.none;
  bannerEl.classList.remove('hidden');

  if (levelKey === 'none') {
    bannerEl.innerHTML = `
      <strong>Documento guardado sin compresión (${preset.label}):</strong>
      Peso final: <b>${formatBytes(finalBytes)}</b> (Calidad 100% original intacta).
    `;
    return;
  }

  const diff = originalBytes - finalBytes;
  const pct = originalBytes > 0 ? ((diff / originalBytes) * 100).toFixed(1) : '0.0';

  if (diff > 0) {
    bannerEl.innerHTML = `
      <strong>¡Guardado con ${preset.label}!</strong><br/>
      Peso inicial: <b>${formatBytes(originalBytes)}</b> → Peso final: <b>${formatBytes(finalBytes)}</b>
      (Ahorro: <b>${formatBytes(diff)}</b> · <b>-${pct}%</b>)
    `;
  } else {
    bannerEl.innerHTML = `
      <strong>Guardado con ${preset.label}:</strong>
      Peso final: <b>${formatBytes(finalBytes)}</b> (El PDF de entrada ya tenía vectores/objetos mínimos).
    `;
  }
}

// ==================== MOTOR CENTRAL DE COMPRESIÓN PDF ====================
/**
 * Comprime un PDF en memoria según el nivel seleccionado ('none', 'low', 'medium', 'high').
 * Devuelve un Uint8Array con los bytes del PDF procesado.
 */
async function applyPdfCompression(inputBytes, level = 'low', onProgress = null) {
  const rawUint8 = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);

  // 1. Limpieza de metadatos y empaquetado con ObjectStreams (base sin pérdida)
  const baseDoc = await PDFDocument.load(rawUint8, { ignoreEncryption: true });
  const cleanDoc = await PDFDocument.create();
  const copiedPages = await cleanDoc.copyPages(baseDoc, baseDoc.getPageIndices());
  copiedPages.forEach((p) => cleanDoc.addPage(p));
  cleanDoc.setTitle('');
  cleanDoc.setAuthor('');
  cleanDoc.setProducer('');
  cleanDoc.setCreator('');
  const losslessBytes = await cleanDoc.save({ useObjectStreams: true, objectsPerTick: 100 });

  if (level === 'none' || !COMPRESSION_PRESETS[level] || !window.pdfjsLib) {
    return losslessBytes;
  }

  const { scale, quality } = COMPRESSION_PRESETS[level];

  // 2. Re-muestreo controlado de páginas mediante PDF.js + recodificación JPEG al nivel elegido
  const pdfJsDoc = await window.pdfjsLib.getDocument({ data: rawUint8.slice(0) }).promise;
  const totalPages = pdfJsDoc.numPages;
  const compressedDoc = await PDFDocument.create();

  for (let p = 1; p <= totalPages; p++) {
    if (onProgress) {
      onProgress(p, totalPages);
    }

    const page = await pdfJsDoc.getPage(p);
    const origViewport = page.getViewport({ scale: 1.0 });
    const renderViewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(renderViewport.width));
    canvas.height = Math.max(1, Math.floor(renderViewport.height));

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;

    const jpegDataUrl = canvas.toDataURL('image/jpeg', quality);
    const jpgImage = await compressedDoc.embedJpg(jpegDataUrl);

    const outPage = compressedDoc.addPage([origViewport.width, origViewport.height]);
    outPage.drawImage(jpgImage, {
      x: 0,
      y: 0,
      width: origViewport.width,
      height: origViewport.height,
    });

    // Liberar memoria del canvas en documentos grandes
    canvas.width = 1;
    canvas.height = 1;
  }

  const rasterBytes = await compressedDoc.save({ useObjectStreams: true, objectsPerTick: 100 });

  // Si el PDF original es de texto puro muy liviano y el nivel 'low' rasterizado supera al original,
  // pero el usuario pidió comprimir, probamos una pasada más ligera o entregamos el menor.
  if (rasterBytes.byteLength >= losslessBytes.byteLength && level === 'low') {
    return losslessBytes;
  }

  return rasterBytes;
}

// ==================== INTERACCIÓN DE SELECTORES DE COMPRESIÓN ====================
document.querySelectorAll('.compression-pills').forEach((group) => {
  const pills = group.querySelectorAll('.comp-pill');
  pills.forEach((pill) => {
    pill.addEventListener('click', () => {
      pills.forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      const radio = pill.querySelector('input[type="radio"]');
      if (radio) radio.checked = true;
    });
  });
});

// ==================== NAVEGACIÓN POR PESTAÑAS ====================
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', b === btn ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${target}`);
    });
  });
});

// ==================== 1. UNIR PDFs ====================
const mergeState = {
  files: [], // { id, name, size, pageCount, arrayBuffer }
};

const mergeDropzone = document.getElementById('merge-dropzone');
const mergeInput = document.getElementById('merge-input');
const mergeAddMoreBtn = document.getElementById('merge-add-more-btn');
const mergeClearBtn = document.getElementById('merge-clear-btn');
const mergeWorkspace = document.getElementById('merge-workspace');
const mergeList = document.getElementById('merge-list');
const mergeResultBox = document.getElementById('merge-result-box');
const mergeRunBtn = document.getElementById('merge-run-btn');

function setupDropzone(dropzoneEl, inputEl, onFilesSelected) {
  dropzoneEl.addEventListener('click', (e) => {
    if (e.target.tagName !== 'INPUT') inputEl.click();
  });
  dropzoneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzoneEl.classList.add('drag-over');
  });
  dropzoneEl.addEventListener('dragleave', () => {
    dropzoneEl.classList.remove('drag-over');
  });
  dropzoneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzoneEl.classList.remove('drag-over');
    if (e.dataTransfer?.files?.length) {
      onFilesSelected(Array.from(e.dataTransfer.files));
    }
  });
  inputEl.addEventListener('change', () => {
    if (inputEl.files?.length) {
      onFilesSelected(Array.from(inputEl.files));
      inputEl.value = '';
    }
  });
}

setupDropzone(mergeDropzone, mergeInput, addFilesToMerge);
mergeAddMoreBtn.addEventListener('click', () => mergeInput.click());

mergeClearBtn.addEventListener('click', () => {
  mergeState.files = [];
  mergeResultBox.classList.add('hidden');
  renderMergeWorkspace();
});

async function addFilesToMerge(fileList) {
  const pdfFiles = fileList.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (!pdfFiles.length) {
    showToast('Por favor selecciona archivos con formato .PDF');
    return;
  }

  showStatus('Leyendo archivos PDF...', `Analizando ${pdfFiles.length} archivo(s)`, 25);

  for (let i = 0; i < pdfFiles.length; i++) {
    const file = pdfFiles[i];
    try {
      const arrayBuffer = await file.arrayBuffer();
      const pdfDoc = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
      mergeState.files.push({
        id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
        name: file.name,
        size: file.size,
        pageCount: pdfDoc.getPageCount(),
        arrayBuffer,
      });
    } catch (err) {
      console.error('Error leyendo PDF:', file.name, err);
      showToast(`No se pudo leer "${file.name}". Verifica que no tenga contraseña.`);
    }
  }

  hideStatus();
  mergeResultBox.classList.add('hidden');
  renderMergeWorkspace();
}

function renderMergeWorkspace() {
  const hasFiles = mergeState.files.length > 0;
  mergeDropzone.classList.toggle('hidden', hasFiles);
  mergeWorkspace.classList.toggle('hidden', !hasFiles);

  if (!hasFiles) return;

  const totalPages = mergeState.files.reduce((acc, f) => acc + f.pageCount, 0);
  const totalSize = mergeState.files.reduce((acc, f) => acc + f.size, 0);

  document.getElementById('merge-count').textContent = `${mergeState.files.length} archivo${mergeState.files.length === 1 ? '' : 's'}`;
  document.getElementById('merge-total-pages').textContent = `${totalPages} página${totalPages === 1 ? '' : 's'}`;
  document.getElementById('merge-total-size').textContent = formatBytes(totalSize);

  mergeList.innerHTML = '';

  mergeState.files.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.draggable = true;
    li.dataset.index = index;

    li.innerHTML = `
      <div class="file-left">
        <span class="drag-handle" title="Arrastra para reordenar">☰</span>
        <span class="order-badge">${index + 1}</span>
        <div class="file-info">
          <div class="file-name" title="${item.name}">${item.name}</div>
          <div class="file-meta">${item.pageCount} pág${item.pageCount === 1 ? '' : 's'} · ${formatBytes(item.size)}</div>
        </div>
      </div>
      <div class="file-actions">
        <button type="button" class="icon-btn move-up" title="Subir posición" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn move-down" title="Bajar posición" ${index === mergeState.files.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="icon-btn remove" title="Quitar de la lista">✕</button>
      </div>
    `;

    li.querySelector('.move-up').addEventListener('click', () => moveMergeItem(index, index - 1));
    li.querySelector('.move-down').addEventListener('click', () => moveMergeItem(index, index + 1));
    li.querySelector('.remove').addEventListener('click', () => {
      mergeState.files.splice(index, 1);
      renderMergeWorkspace();
    });

    li.addEventListener('dragstart', (e) => {
      li.classList.add('dragging');
      e.dataTransfer.setData('text/plain', String(index));
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIndex = Number(e.dataTransfer.getData('text/plain'));
      const toIndex = index;
      if (!Number.isNaN(fromIndex) && fromIndex !== toIndex) {
        moveMergeItem(fromIndex, toIndex);
      }
    });

    mergeList.appendChild(li);
  });
}

function moveMergeItem(from, to) {
  if (to < 0 || to >= mergeState.files.length) return;
  const [moved] = mergeState.files.splice(from, 1);
  mergeState.files.splice(to, 0, moved);
  renderMergeWorkspace();
}

mergeRunBtn.addEventListener('click', async () => {
  if (mergeState.files.length < 2) {
    showToast('Agrega al menos 2 archivos PDF para unirlos.');
    return;
  }

  const compressionLevel = document.querySelector('input[name="merge-compression"]:checked')?.value || 'low';
  const sumOriginalBytes = mergeState.files.reduce((acc, f) => acc + f.size, 0);

  try {
    showStatus('Uniendo archivos PDF...', 'Combinando páginas...', 10);
    const mergedPdf = await PDFDocument.create();

    for (let i = 0; i < mergeState.files.length; i++) {
      const item = mergeState.files[i];
      const progress = Math.round(((i + 1) / mergeState.files.length) * 45);
      showStatus('Uniendo archivos PDF...', `Copiando páginas de "${item.name}"...`, progress);

      const srcDoc = await PDFDocument.load(item.arrayBuffer, { ignoreEncryption: true });
      const copiedPages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
    }

    const rawMergedBytes = await mergedPdf.save({ useObjectStreams: true });

    const finalBytes = await applyPdfCompression(rawMergedBytes, compressionLevel, (page, total) => {
      const pct = 45 + Math.round((page / total) * 50);
      showStatus(
        'Aplicando compresión al PDF unido...',
        `Comprimiendo página ${page} de ${total} (${COMPRESSION_PRESETS[compressionLevel].label})...`,
        pct
      );
    });

    const rawName = document.getElementById('merge-filename').value.trim() || 'documento-unido';
    const cleanName = rawName.replace(/\.pdf$/i, '') + '.pdf';
    downloadBlob(finalBytes, cleanName);

    renderCompressionSummaryBanner(mergeResultBox, sumOriginalBytes, finalBytes.byteLength, compressionLevel);
    hideStatus();
    showToast(`¡PDF unido y guardado como ${cleanName}!`);
  } catch (err) {
    console.error(err);
    hideStatus();
    showToast('Ocurrió un error al unir y comprimir los archivos PDF.');
  }
});

// ==================== 2. SEPARAR PDF ====================
const splitState = {
  fileName: '',
  originalSize: 0,
  arrayBuffer: null,
  pageCount: 0,
  selectedPages: new Set(), // 1-indexed
};

const splitDropzone = document.getElementById('split-dropzone');
const splitInput = document.getElementById('split-input');
const splitWorkspace = document.getElementById('split-workspace');
const splitPagesGrid = document.getElementById('split-pages-grid');
const splitRangeInput = document.getElementById('split-range-input');
const splitResultBox = document.getElementById('split-result-box');
const splitRunBtn = document.getElementById('split-run-btn');

setupDropzone(splitDropzone, splitInput, (files) => loadSplitFile(files[0]));

document.getElementById('split-change-file-btn').addEventListener('click', () => {
  splitState.arrayBuffer = null;
  splitState.selectedPages.clear();
  splitResultBox.classList.add('hidden');
  splitDropzone.classList.remove('hidden');
  splitWorkspace.classList.add('hidden');
});

document.getElementById('split-select-all-btn').addEventListener('click', () => {
  for (let i = 1; i <= splitState.pageCount; i++) splitState.selectedPages.add(i);
  syncSplitSelectionToUI();
});

document.getElementById('split-select-none-btn').addEventListener('click', () => {
  splitState.selectedPages.clear();
  syncSplitSelectionToUI();
});

document.querySelectorAll('input[name="split-mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const isZip = document.querySelector('input[name="split-mode"]:checked').value === 'zip-pages';
    document.getElementById('split-ext-label').textContent = isZip ? '.zip' : '.pdf';
  });
});

async function loadSplitFile(file) {
  if (!file) return;
  try {
    showStatus('Cargando páginas del PDF...', 'Generando vista previa de páginas...', 20);
    const buffer = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const count = pdfDoc.getPageCount();

    splitState.fileName = file.name.replace(/\.pdf$/i, '');
    splitState.originalSize = file.size;
    splitState.arrayBuffer = buffer;
    splitState.pageCount = count;
    splitState.selectedPages = new Set(Array.from({ length: count }, (_, i) => i + 1));

    document.getElementById('split-file-name').textContent = file.name;
    document.getElementById('split-total-pages').textContent = `${count} página${count === 1 ? '' : 's'}`;
    document.getElementById('split-original-size').textContent = formatBytes(file.size);
    document.getElementById('split-filename').value = `${splitState.fileName}-extraido`;

    splitResultBox.classList.add('hidden');
    splitDropzone.classList.add('hidden');
    splitWorkspace.classList.remove('hidden');

    await renderSplitThumbnails(buffer, count);
    syncSplitSelectionToUI();
    hideStatus();
  } catch (err) {
    console.error(err);
    hideStatus();
    showToast('No se pudo abrir el PDF para separar.');
  }
}

async function renderSplitThumbnails(arrayBuffer, totalPages) {
  splitPagesGrid.innerHTML = '';
  let pdfJsDoc = null;
  if (window.pdfjsLib) {
    try {
      pdfJsDoc = await window.pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
    } catch (e) {
      console.warn('Vista previa con PDF.js no disponible:', e);
    }
  }

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const card = document.createElement('div');
    card.className = 'page-card selected';
    card.dataset.page = pageNum;

    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 215;

    card.innerHTML = `
      <div class="page-check">✓</div>
      <div class="page-card-label">Página ${pageNum}</div>
    `;
    card.insertBefore(canvas, card.querySelector('.page-card-label'));

    card.addEventListener('click', () => {
      if (splitState.selectedPages.has(pageNum)) {
        splitState.selectedPages.delete(pageNum);
      } else {
        splitState.selectedPages.add(pageNum);
      }
      syncSplitSelectionToUI();
    });

    splitPagesGrid.appendChild(card);

    if (pdfJsDoc) {
      pdfJsDoc.getPage(pageNum).then((page) => {
        const viewport = page.getViewport({ scale: 0.32 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        page.render({ canvasContext: ctx, viewport });
      });
    }
  }
}

function pagesSetToRangeString(pagesSet) {
  const sorted = Array.from(pagesSet).sort((a, b) => a - b);
  if (!sorted.length) return '';
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i <= sorted.length; i++) {
    const curr = sorted[i];
    if (curr === prev + 1) {
      prev = curr;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = curr;
      prev = curr;
    }
  }
  return ranges.join(', ');
}

function parseRangeStringToSet(str, maxPage) {
  const result = new Set();
  const parts = str.split(',');
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((n) => parseInt(n.trim(), 10));
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        const from = Math.max(1, Math.min(a, b));
        const to = Math.min(maxPage, Math.max(a, b));
        for (let p = from; p <= to; p++) result.add(p);
      }
    } else {
      const num = parseInt(part, 10);
      if (!Number.isNaN(num) && num >= 1 && num <= maxPage) {
        result.add(num);
      }
    }
  }
  return result;
}

function syncSplitSelectionToUI() {
  splitRangeInput.value = pagesSetToRangeString(splitState.selectedPages);
  splitPagesGrid.querySelectorAll('.page-card').forEach((card) => {
    const p = Number(card.dataset.page);
    card.classList.toggle('selected', splitState.selectedPages.has(p));
  });
}

splitRangeInput.addEventListener('input', () => {
  splitState.selectedPages = parseRangeStringToSet(splitRangeInput.value, splitState.pageCount);
  splitPagesGrid.querySelectorAll('.page-card').forEach((card) => {
    const p = Number(card.dataset.page);
    card.classList.toggle('selected', splitState.selectedPages.has(p));
  });
});

splitRunBtn.addEventListener('click', async () => {
  const pages = Array.from(splitState.selectedPages).sort((a, b) => a - b);
  if (!pages.length) {
    showToast('Selecciona al menos una página para extraer.');
    return;
  }

  const mode = document.querySelector('input[name="split-mode"]:checked').value;
  const compressionLevel = document.querySelector('input[name="split-compression"]:checked')?.value || 'low';
  const baseName = (document.getElementById('split-filename').value.trim() || 'paginas-extraidas').replace(/\.(pdf|zip)$/i, '');

  try {
    showStatus('Extrayendo páginas...', `Procesando ${pages.length} página(s)...`, 20);
    const srcDoc = await PDFDocument.load(splitState.arrayBuffer, { ignoreEncryption: true });

    if (mode === 'single-pdf') {
      const outDoc = await PDFDocument.create();
      const zeroIndices = pages.map((p) => p - 1);
      const copied = await outDoc.copyPages(srcDoc, zeroIndices);
      copied.forEach((p) => outDoc.addPage(p));
      const rawExtractedBytes = await outDoc.save({ useObjectStreams: true });

      const finalBytes = await applyPdfCompression(rawExtractedBytes, compressionLevel, (page, total) => {
        const pct = 35 + Math.round((page / total) * 60);
        showStatus('Comprimiendo PDF extraído...', `Página ${page} de ${total}...`, pct);
      });

      downloadBlob(finalBytes, `${baseName}.pdf`);
      renderCompressionSummaryBanner(splitResultBox, rawExtractedBytes.byteLength, finalBytes.byteLength, compressionLevel);
      hideStatus();
      showToast(`¡${pages.length} página(s) guardadas en ${baseName}.pdf!`);
    } else {
      const zipFiles = {};
      let rawSumBytes = 0;
      let compressedSumBytes = 0;

      for (let i = 0; i < pages.length; i++) {
        const pageNum = pages[i];
        showStatus(
          'Separando y comprimiendo páginas...',
          `Procesando página ${pageNum} (${i + 1} de ${pages.length})...`,
          Math.round(((i + 1) / pages.length) * 88)
        );

        const singleDoc = await PDFDocument.create();
        const [copiedPage] = await singleDoc.copyPages(srcDoc, [pageNum - 1]);
        singleDoc.addPage(copiedPage);
        const rawPageBytes = await singleDoc.save({ useObjectStreams: true });
        rawSumBytes += rawPageBytes.byteLength;

        const compressedPageBytes = await applyPdfCompression(rawPageBytes, compressionLevel);
        compressedSumBytes += compressedPageBytes.byteLength;

        zipFiles[`${baseName}-pag-${String(pageNum).padStart(2, '0')}.pdf`] = new Uint8Array(compressedPageBytes);
      }

      const zippedBytes = window.fflate.zipSync(zipFiles, { level: 6 });
      downloadBlob(zippedBytes, `${baseName}.zip`, 'application/zip');
      renderCompressionSummaryBanner(splitResultBox, rawSumBytes, compressedSumBytes, compressionLevel);
      hideStatus();
      showToast(`¡Páginas descargadas en ${baseName}.zip!`);
    }
  } catch (err) {
    console.error(err);
    hideStatus();
    showToast('Error al separar el archivo PDF.');
  }
});

// ==================== 3. COMPRIMIR PDF ====================
const compressState = {
  fileName: '',
  originalSize: 0,
  pageCount: 0,
  arrayBuffer: null,
};

const compressDropzone = document.getElementById('compress-dropzone');
const compressInput = document.getElementById('compress-input');
const compressWorkspace = document.getElementById('compress-workspace');
const compressResultBox = document.getElementById('compress-result-box');
const compressRunBtn = document.getElementById('compress-run-btn');

setupDropzone(compressDropzone, compressInput, (files) => loadCompressFile(files[0]));

document.getElementById('compress-change-btn').addEventListener('click', () => {
  compressState.arrayBuffer = null;
  compressResultBox.classList.add('hidden');
  compressDropzone.classList.remove('hidden');
  compressWorkspace.classList.add('hidden');
});

document.querySelectorAll('.preset-card').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.preset-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    card.querySelector('input[type="radio"]').checked = true;
  });
});

async function loadCompressFile(file) {
  if (!file) return;
  try {
    showStatus('Analizando PDF...', 'Calculando estructura del documento...', 30);
    const buffer = await file.arrayBuffer();
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });

    compressState.fileName = file.name.replace(/\.pdf$/i, '');
    compressState.originalSize = file.size;
    compressState.pageCount = doc.getPageCount();
    compressState.arrayBuffer = buffer;

    document.getElementById('compress-file-name').textContent = file.name;
    document.getElementById('compress-original-size').textContent = formatBytes(file.size);
    document.getElementById('compress-page-count').textContent = `${compressState.pageCount} págs`;
    document.getElementById('compress-filename').value = `${compressState.fileName}-comprimido`;

    compressResultBox.classList.add('hidden');
    compressDropzone.classList.add('hidden');
    compressWorkspace.classList.remove('hidden');
    hideStatus();
  } catch (err) {
    console.error(err);
    hideStatus();
    showToast('No se pudo cargar el archivo PDF.');
  }
}

compressRunBtn.addEventListener('click', async () => {
  if (!compressState.arrayBuffer) return;

  const level = document.querySelector('input[name="compress-level"]:checked')?.value || 'medium';

  try {
    showStatus('Comprimiendo PDF...', `Iniciando ${COMPRESSION_PRESETS[level].label}...`, 10);

    const compressedBytes = await applyPdfCompression(
      compressState.arrayBuffer,
      level,
      (page, total) => {
        const progress = Math.round((page / total) * 90);
        showStatus(
          'Comprimiendo PDF...',
          `Optimizando página ${page} de ${total} (${COMPRESSION_PRESETS[level].label})...`,
          progress
        );
      }
    );

    renderCompressionSummaryBanner(
      compressResultBox,
      compressState.originalSize,
      compressedBytes.byteLength,
      level
    );

    const outName = (document.getElementById('compress-filename').value.trim() || 'documento-comprimido').replace(/\.pdf$/i, '') + '.pdf';
    downloadBlob(compressedBytes, outName);
    hideStatus();
    showToast(`¡PDF comprimido guardado como ${outName}!`);
  } catch (err) {
    console.error(err);
    hideStatus();
    showToast('Error al comprimir el PDF.');
  }
});
