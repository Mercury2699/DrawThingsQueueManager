// ==============================================================================
// GLOBAL STATE & APIS
// ==============================================================================
const API = {
    getModels: () => fetch('/api/models').then(r => r.json()),
    getQueue: () => fetch('/api/queue').then(r => r.json()),
    getHistory: () => fetch('/api/history').then(r => r.json()),
    getStatus: () => fetch('/api/status').then(r => r.json()),
    control: (action) => fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
    }).then(r => r.json()),
    addToQueue: (data) => fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(r => r.json()),
    deleteQueue: (id) => fetch(`/api/queue/${id}`, { method: 'DELETE' }).then(r => r.json()),
    updateQueue: (id, data) => fetch(`/api/queue/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).then(r => {
        if (!r.ok) {
            return r.json().then(err => { throw new Error(err.detail || 'Failed to update queue item'); });
        }
        return r.json();
    }),
    reorderQueue: (items) => fetch('/api/queue/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items })
    }).then(r => r.json()),
    getSettings: () => fetch('/api/settings').then(r => r.json()),
    saveSettings: (settings) => fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    }).then(r => r.json()),
    getStorage: () => fetch('/api/storage').then(r => r.json()),
    cleanLocal: () => fetch('/api/storage/clean-local', { method: 'POST' }).then(r => r.json()),
    vacuumDb: () => fetch('/api/storage/vacuum-db', { method: 'POST' }).then(r => r.json())
};

let state = {
    models: [],
    loras: [],
    queue: [],
    history: [],
    status: { running: false, current_task: null, error_message: null },
    settings: { draw_things_api: '' }
};

// Image Dimension / Aspect Ratio State
let sizeState = {
    ratio: '1:1',
    size: 1024
};

// Reference image state (base64 without data: prefix, or null)
let refImageBase64 = { create: null, edit: null };


// ==============================================================================
// INIT FORMS
// ==============================================================================
function initForms() {
    const template = document.getElementById('task-form-template');
    
    // Init Create Form
    const createContainer = document.getElementById('create-form-container');
    if (createContainer && template) {
        createContainer.appendChild(template.content.cloneNode(true));
        setupFormListeners(createContainer, 'create');
        populateModelsAndLoras(createContainer, 'create');
    }
    
    // Init Edit Form
    const editContainer = document.getElementById('edit-form-container');
    if (editContainer && template) {
        editContainer.appendChild(template.content.cloneNode(true));
        setupFormListeners(editContainer, 'edit');
    }
}

function setupFormListeners(container, ctx) {
    const stateObj = ctx === 'create' ? sizeState : editSizeState;
    const isEdit = ctx === 'edit';
    
    // Aspect ratio selection
    const ratioButtons = container.querySelectorAll('.btn-ratio');
    ratioButtons.forEach(btn => {
        btn.addEventListener('click', (e) => {
            ratioButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            stateObj.ratio = btn.getAttribute('data-ratio');
            updateDimensions(ctx);
        });
    });

    // Size slider input
    const sizeSlider = container.querySelector('.input-size-slider');
    if (sizeSlider) {
        sizeSlider.addEventListener('input', (e) => {
            stateObj.size = parseInt(e.target.value);
            updateDimensions(ctx);
        });
    }

    // Ref image dropzone
    const dropzone = container.querySelector('.container-ref-dropzone');
    const refImageInput = container.querySelector('.input-ref-image');
    if (dropzone) {
        dropzone.addEventListener('dragover', handleRefImageDragOver);
        dropzone.addEventListener('dragleave', handleRefImageDragLeave);
        dropzone.addEventListener('drop', (e) => handleRefImageDrop(e, ctx));
        dropzone.addEventListener('click', () => refImageInput.click());
    }
    
    if (refImageInput) {
        refImageInput.addEventListener('change', (e) => handleRefImageFile(e, ctx));
    }
    
    const removeRefBtn = container.querySelector('.btn-remove-ref');
    if (removeRefBtn) {
        removeRefBtn.addEventListener('click', (e) => clearRefImage(ctx, e));
    }
    
    const denoisingSlider = container.querySelector('.input-denoising-strength');
    if (denoisingSlider) {
        denoisingSlider.addEventListener('input', (e) => {
            container.querySelector('.denoising-value-display').textContent = parseFloat(e.target.value).toFixed(2);
        });
    }
}

// ==============================================================================
// REFERENCE IMAGE HANDLERS (img2img)
// ==============================================================================
function handleRefImageDragOver(e) {
    e.preventDefault();
    e.currentTarget.classList.add('drag-over');
}
function handleRefImageDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
}
function handleRefImageDrop(e, ctx) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) loadRefImageFile(file, ctx);
}
function handleRefImageFile(e, ctx) {
    const file = e.target.files[0];
    if (file) loadRefImageFile(file, ctx);
    e.target.value = ''; // reset so same file can be re-selected
}
function loadRefImageFile(file, ctx) {
    const reader = new FileReader();
    reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        // Strip the data:image/...;base64, prefix — store raw base64
        refImageBase64[ctx] = dataUrl.split(',')[1];
        
        const container = ctx === 'create' ? document.getElementById('create-form-container') : document.getElementById('edit-form-container');
        if (!container) return;
        
        // Show thumbnail and hide idle text
        const thumb = container.querySelector('.ref-image-thumb');
        if (thumb) thumb.src = dataUrl;
        
        const idle = container.querySelector('.dropzone-idle');
        if (idle) idle.style.display = 'none';
        
        const preview = container.querySelector('.dropzone-preview');
        if (preview) {
            preview.classList.remove('hidden');
            preview.style.display = 'block';
        }
        
        const group = container.querySelector('.denoising-group');
        if (group) group.classList.remove('hidden');
        
        // Auto-detect aspect ratio
        const img = new Image();
        img.onload = () => {
            const ratios = {
                '16:9': 16/9,
                '3:2': 3/2,
                '4:3': 4/3,
                '1:1': 1,
                '3:4': 3/4,
                '2:3': 2/3,
                '9:16': 9/16
            };
            const imgRatio = img.width / img.height;
            let closestRatio = '1:1';
            let minDiff = Infinity;
            
            for (const [key, val] of Object.entries(ratios)) {
                const diff = Math.abs(imgRatio - val);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestRatio = key;
                }
            }
            
            // Auto-select the closest ratio button for this context
            if (ctx === 'create') {
                const ratioBtns = document.querySelectorAll('#create-form-container .btn-ratio');
                ratioBtns.forEach(btn => {
                    if (btn.getAttribute('data-ratio') === closestRatio) {
                        btn.click();
                    }
                });
            }
        };
        img.src = dataUrl;
    };
    reader.readAsDataURL(file);
}

function clearRefImage(ctx, event) {
    if (event && event.stopPropagation) event.stopPropagation(); // don't re-open file picker
    refImageBase64[ctx] = null;
    
    const container = ctx === 'create' ? document.getElementById('create-form-container') : document.getElementById('edit-form-container');
    if (!container) return;
    
    const thumb = container.querySelector('.ref-image-thumb');
    if (thumb) thumb.src = '';
    
    const idle = container.querySelector('.dropzone-idle');
    if (idle) {
        idle.classList.remove('hidden');
        idle.style.display = ''; 
    }
    
    const preview = container.querySelector('.dropzone-preview');
    if (preview) {
        preview.classList.add('hidden');
        preview.style.display = 'none';
    }
    
    const group = container.querySelector('.denoising-group');
    if (group) group.classList.add('hidden');
    
    const input = container.querySelector('.input-ref-image');
    if (input) input.value = '';
}


function updateDimensions(ctx = 'create') {
    try {
        const stateObj = ctx === 'create' ? sizeState : editSizeState;
        const container = ctx === 'create' ? document.getElementById('create-form-container') : document.getElementById('edit-form-container');
        
        let r = stateObj.ratio || '1:1';
        let s = stateObj.size || 1024;
        let w = s;
        let h = s;
        
        let parts = r.split(':');
        let x = parseInt(parts[0]);
        let y = parseInt(parts[1]);
        
        if (x === y) {
            w = s;
            h = s;
        } else if (x < y) { // Portrait (e.g. 2:3, 3:4, 9:16)
            h = s;
            w = s * x / y;
            if (w < 512) {
                w = 512;
                h = 512 * y / x;
            }
        } else { // Landscape (e.g. 3:2, 4:3, 16:9)
            w = s;
            h = s * y / x;
            if (h < 512) {
                h = 512;
                w = 512 * x / y;
            }
        }
        
        w = Math.round(w / 64) * 64;
        h = Math.round(h / 64) * 64;
        
        w = Math.max(512, Math.min(2048, w));
        h = Math.max(512, Math.min(2048, h));
        
        const widthInput = container.querySelector('.input-width');
        const heightInput = container.querySelector('.input-height');
        const displaySpan = container.querySelector('.size-value-display');
        
        if (widthInput) widthInput.value = w;
        if (heightInput) heightInput.value = h;
        if (displaySpan) displaySpan.innerText = `${s}px`;
        
        if (ctx === 'create') saveParamsToLocalStorage(); // Auto-save on dimensions change
    } catch (e) {
        console.error("Error updating dimensions:", e);
    }
}

function setSizeStateFromDimensions(w, h, ctx = 'create') {
    const stateObj = ctx === 'create' ? sizeState : editSizeState;
    const container = ctx === 'create' ? document.getElementById('create-form-container') : document.getElementById('edit-form-container');
    if (!container) return;
    
    let actualRatio = w / h;
    const knownRatios = {
        '1:1': 1,
        '3:2': 1.5,
        '4:3': 1.3333,
        '16:9': 1.7777,
        '2:3': 0.6666,
        '3:4': 0.75,
        '9:16': 0.5625
    };
    
    let matchedRatio = '1:1';
    let minDiff = Infinity;
    
    for (const [rStr, rVal] of Object.entries(knownRatios)) {
        const diff = Math.abs(actualRatio - rVal);
        if (diff < minDiff) {
            minDiff = diff;
            matchedRatio = rStr;
        }
    }
    
    let matchedSize = Math.max(w, h);
    
    stateObj.ratio = matchedRatio;
    stateObj.size = matchedSize;
    
    const ratioButtons = container.querySelectorAll('.btn-ratio');
    ratioButtons.forEach(btn => {
        if (btn.getAttribute('data-ratio') === matchedRatio) btn.classList.add('active');
        else btn.classList.remove('active');
    });
    
    const sizeSlider = container.querySelector('.input-size-slider');
    if (sizeSlider) sizeSlider.value = matchedSize;
    
    updateDimensions(ctx);
}


function saveParamsToLocalStorage() {
    try {
        const promptEl = document.querySelector('#create-form-container .input-prompt');
        const negEl = document.querySelector('#create-form-container .input-negative-prompt');
        const stepsEl = document.querySelector('#create-form-container .input-steps');
        const cfgEl = document.querySelector('#create-form-container .input-cfg-scale');
        const batchEl = document.querySelector('#create-form-container .input-batch-count');
        const seedEl = document.querySelector('#create-form-container .input-seed');
        const autoUploadEl = document.querySelector('#create-form-container .input-auto-upload');
        
        const params = {
            prompt: promptEl ? promptEl.value : '',
            negative_prompt: negEl ? negEl.value : '',
            steps: stepsEl ? parseInt(stepsEl.value) : 8,
            cfg_scale: cfgEl ? parseFloat(cfgEl.value) : 1.0,
            batch_count: batchEl ? parseInt(batchEl.value) : 2,
            seed: seedEl ? parseInt(seedEl.value) : -1,
            auto_upload: autoUploadEl ? autoUploadEl.checked : false,
            ratio: sizeState.ratio,
            size: sizeState.size,
            
            // Models selection
            models: Array.from(document.querySelectorAll('#create-form-container input[name="model"]:checked')).map(el => el.value),
            
            // LoRAs selection
            loras: Array.from(document.querySelectorAll('#create-form-container .lora-item-row.active')).map(row => {
                const cb = row.querySelector('input[name="lora-enable"]');
                const slider = row.querySelector('.lora-weight-slider');
                return {
                    file: cb ? cb.value : '',
                    weight: slider ? parseFloat(slider.value) : 1.0
                };
            })
        };
        localStorage.setItem('dt_queue_params', JSON.stringify(params));
    } catch (e) {
        console.error("Error saving parameters to localStorage:", e);
    }
}

function restoreParamsFromLocalStorage() {
    try {
        const dataStr = localStorage.getItem('dt_queue_params');
        if (!dataStr) {
            // Default batch count to 2 if no history settings
            const batchEl = document.querySelector('#create-form-container .input-batch-count');
            if (batchEl) batchEl.value = 2;
            return;
        }
        
        const params = JSON.parse(dataStr);
        if (!params) return;
        
        // Restore values
        if (params.prompt !== undefined && document.querySelector('#create-form-container .input-prompt')) 
            document.querySelector('#create-form-container .input-prompt').value = params.prompt;
        if (params.negative_prompt !== undefined && document.querySelector('#create-form-container .input-negative-prompt')) 
            document.querySelector('#create-form-container .input-negative-prompt').value = params.negative_prompt;
        if (params.steps !== undefined && document.querySelector('#create-form-container .input-steps')) 
            document.querySelector('#create-form-container .input-steps').value = params.steps;
        if (params.cfg_scale !== undefined && document.querySelector('#create-form-container .input-cfg-scale')) 
            document.querySelector('#create-form-container .input-cfg-scale').value = params.cfg_scale;
        
        // Set batch-count (safely defaulting to 2)
        const batchEl = document.querySelector('#create-form-container .input-batch-count');
        if (batchEl) {
            batchEl.value = params.batch_count !== undefined ? params.batch_count : 2;
        }
        
        if (params.seed !== undefined && document.querySelector('#create-form-container .input-seed')) 
            document.querySelector('#create-form-container .input-seed').value = params.seed;
            
        if (params.auto_upload !== undefined && document.querySelector('#create-form-container .input-auto-upload'))
            document.querySelector('#create-form-container .input-auto-upload').checked = params.auto_upload;
        
        if (params.ratio) sizeState.ratio = params.ratio;
        if (params.size) sizeState.size = params.size;
        
        // Update active ratio buttons
        const ratioButtons = document.querySelectorAll('#create-form-container .btn-ratio');
        ratioButtons.forEach(btn => {
            if (btn.getAttribute('data-ratio') === sizeState.ratio) btn.classList.add('active');
            else btn.classList.remove('active');
        });
        
        // Update size slider
        const sizeSlider = document.querySelector('#create-form-container .input-size-slider');
        if (sizeSlider && params.size) {
            sizeSlider.value = params.size;
        }
        
        updateDimensions();
        
        // Restore models checkmarks
        if (params.models && Array.isArray(params.models)) {
            const modelCheckboxes = document.querySelectorAll('#create-form-container input[name="model"]');
            modelCheckboxes.forEach(cb => {
                cb.checked = params.models.includes(cb.value);
            });
        }
        
        // Restore LoRAs checkmarks & sliders
        if (params.loras && Array.isArray(params.loras)) {
            params.loras.forEach(savedLora => {
                const cleaned = cleanId(savedLora.file);
                const row = document.querySelector(`#create-form-container .lora-item-row[data-id="${cleaned}"]`);
                if (row) {
                    const cb = row.querySelector('input[name="lora-enable"]');
                    const slider = row.querySelector('.lora-weight-slider');
                    const valSpan = row.querySelector('.lora-weight-value');
                    
                    if (cb && slider) {
                        cb.checked = true;
                        row.classList.add('active');
                        slider.value = savedLora.weight;
                        if (valSpan) valSpan.innerText = parseFloat(savedLora.weight).toFixed(1);
                    }
                }
            });
        }
    } catch (e) {
        console.error("Error restoring parameters from localStorage:", e);
    }
}

// ==============================================================================
// INITIALIZATION
// ==============================================================================
document.addEventListener('DOMContentLoaded', () => {
    initApp();
});

async function initApp() {
    updateDimensions(); // Set initial dimensions instantly!
    initForms();
    setupEventListeners();
    
    try {
        await loadSettings();
        await loadModels();
        restoreParamsFromLocalStorage(); // Restore from localStorage
        await refreshQueue();
        await refreshHistory();
    } catch (e) {
        console.error("Failed loading app data during initialization:", e);
    }
    
    // Start status polling loop
    pollStatus();
    setInterval(pollStatus, 1500);
}

// ==============================================================================
// SETTINGS MANAGEMENT
// ==============================================================================
async function loadSettings() {
    try {
        state.settings = await API.getSettings();
        document.getElementById('setting-api-url').value = state.settings.draw_things_api || '';
        document.getElementById('setting-civitai-cookies').value = state.settings.civitai_cookies || '';
        document.getElementById('setting-civitai-mapping').value = state.settings.civitai_model_mapping || '';
    } catch (e) {
        console.error("Failed to load settings:", e);
    }
}

async function saveSettings() {
    const apiUrl = document.getElementById('setting-api-url').value.trim();
    if (!apiUrl) return;
    
    const civitaiCookies = document.getElementById('setting-civitai-cookies').value.trim();
    const civitaiMapping = document.getElementById('setting-civitai-mapping').value.trim();
    
    try {
        await API.saveSettings({
            draw_things_api: apiUrl,
            civitai_cookies: civitaiCookies,
            civitai_model_mapping: civitaiMapping,
        });
        state.settings.draw_things_api = apiUrl;
        toggleModal('settings-modal', false);
        showToast("Settings saved successfully!");
    } catch (e) {
        showToast("Failed to save settings: " + e.message, true);
    }
}

// ==============================================================================
// MODEL SCANNING & RENDERING
// ==============================================================================
async function loadModels() {
    try {
        const data = await API.getModels();
        state.models = data.models;
        state.loras = data.loras;
        
        // Populate settings modal paths
        document.getElementById('models-folder-path').innerText = data.models_dir;
        const statusEl = document.getElementById('models-folder-status');
        if (data.models_dir_exists) {
            statusEl.innerText = "✓ Active Models Folder Found";
            statusEl.style.color = "var(--accent-green)";
        } else {
            statusEl.innerText = "✗ Models Folder Not Found. Using fallback defaults.";
            statusEl.style.color = "var(--accent-red)";
        }

        const createContainer = document.getElementById('create-form-container');
        if (createContainer) {
            populateModelsAndLoras(createContainer, 'create');
        }
    } catch (e) {
        console.error("Failed to load models/loras:", e);
    }
}

function populateModelsAndLoras(container, ctx) {
    const modelsContainer = container.querySelector('.models-list-container');
    const lorasContainer = container.querySelector('.loras-list-container');
    if (!modelsContainer || !lorasContainer) return;

    // Render Models Checkboxes
    if (state.models.length === 0) {
        modelsContainer.innerHTML = '<div class="loading-inline">No models found in Draw Things folder.</div>';
    } else {
        modelsContainer.innerHTML = state.models.map((m, idx) => `
            <label class="model-checkbox-label">
                <input type="checkbox" name="model" value="${m}" ${idx === 0 ? 'checked' : ''}>
                <span>${m}</span>
            </label>
        `).join('');
    }

    // Render LoRAs Checkboxes + Weight Sliders
    if (state.loras.length === 0) {
        lorasContainer.innerHTML = '<div class="loading-inline">No LoRAs found in Draw Things folder.</div>';
    } else {
        lorasContainer.innerHTML = state.loras.map((l) => `
            <div class="lora-item-row" data-id="${cleanId(l)}">
                <div class="lora-item-top">
                    <label class="lora-checkbox-container">
                        <input type="checkbox" name="lora-enable" value="${l}" onchange="this.closest('.lora-item-row').classList.toggle('active', this.checked)">
                        <span>${l}</span>
                    </label>
                </div>
                <div class="lora-weight-container">
                    <input type="range" class="lora-weight-slider" min="-2.0" max="2.0" step="0.05" value="1.0" oninput="this.nextElementSibling.innerText = parseFloat(this.value).toFixed(1)">
                    <span class="lora-weight-value">1.0</span>
                </div>
            </div>
        `).join('');
    }
}

function cleanId(filename) {
    return filename.replace(/[^a-zA-Z0-9]/g, '_');
}

// ==============================================================================
// TASK CREATION
// ==============================================================================
async function handleTaskFormSubmit(e) {
    e.preventDefault();
    
    const prompt = document.querySelector('#create-form-container .input-prompt').value.trim();
    const negativePrompt = document.querySelector('#create-form-container .input-negative-prompt').value.trim();
    const width = parseInt(document.querySelector('#create-form-container .input-width').value);
    const height = parseInt(document.querySelector('#create-form-container .input-height').value);
    const steps = parseInt(document.querySelector('#create-form-container .input-steps').value);
    const cfgScale = parseFloat(document.querySelector('#create-form-container .input-cfg-scale').value);
    const batchCount = parseInt(document.querySelector('#create-form-container .input-batch-count').value);
    const seed = parseInt(document.querySelector('#create-form-container .input-seed').value);

    // Selected Models
    const modelCheckedElements = document.querySelectorAll('#create-form-container input[name="model"]:checked');
    const selectedModels = Array.from(modelCheckedElements).map(el => el.value);
    
    if (selectedModels.length === 0) {
        showToast("Please select at least one Base Model!", true);
        return;
    }

    // Selected LoRAs
    const selectedLoras = [];
    const loraRows = document.querySelectorAll('#create-form-container .lora-item-row.active');
    loraRows.forEach(row => {
        const checkbox = row.querySelector('input[name="lora-enable"]');
        const slider = row.querySelector('.lora-weight-slider');
        if (checkbox && slider && checkbox.checked) {
            selectedLoras.push({
                file: checkbox.value,
                weight: parseFloat(slider.value)
            });
        }
    });

    const taskData = {
        prompt,
        negative_prompt: negativePrompt,
        models: selectedModels,
        steps,
        cfg_scale: cfgScale,
        width,
        height,
        loras: selectedLoras,
        batch_count: batchCount,
        seed,
        auto_upload: document.querySelector('#create-form-container .input-auto-upload')?.checked || false,
        init_image: refImageBase64.create || null,
        denoising_strength: refImageBase64.create ? parseFloat(document.querySelector('#create-form-container .input-denoising-strength').value) : 0.6
    };

    try {
        await API.addToQueue(taskData);
        showToast("Task successfully queued!");
        
        // Reset only the prompt textarea and ref image, keep other settings
        document.querySelector('#create-form-container .input-prompt').value = '';
        clearRefImage('create', { stopPropagation: () => {} });
        
        await refreshQueue();
    } catch (err) {
        showToast("Failed to queue task: " + err.message, true);
    }
}

// ==============================================================================
// QUEUE RENDERING & INTERACTIONS
// ==============================================================================
async function refreshQueue() {
    try {
        state.queue = await API.getQueue();
        renderQueue();
    } catch (e) {
        console.error("Error loading queue:", e);
    }
}

function renderQueue() {
    const container = document.getElementById('queue-list-container');
    const countEl = document.getElementById('queue-count');
    
    countEl.innerText = `${state.queue.length} tasks`;
    
    if (state.queue.length === 0) {
        container.innerHTML = '<div class="empty-state">Queue is empty.</div>';
        return;
    }
    
    container.innerHTML = state.queue.map((item, idx) => {
        const isCurrent = state.status.current_task && state.status.current_task.queue_id === item.id;
        const cardClass = `queue-item-card ${isCurrent ? 'processing' : item.status}`;
        
        const lorasList = item.loras.map(l => `${l.file.split('_lora_')[0]} (${l.weight})`).join(', ') || 'None';
        
        // Upload status badge
        let uploadBadge = '';
        if (item.upload_status === 'uploading') {
            uploadBadge = '<span class="badge badge-uploading">↑ Uploading…</span>';
        } else if (item.upload_status === 'uploaded') {
            uploadBadge = '<span class="badge badge-uploaded">✓ Uploaded</span>';
        } else if (item.upload_status === 'upload_failed') {
            uploadBadge = '<span class="badge badge-upload-failed">✗ Upload failed</span>';
        } else if (item.auto_upload) {
            uploadBadge = '<span class="badge badge-auto-upload">⬆ Auto-upload</span>';
        }
        
        // i2i badge
        const i2iBadge = item.init_image ? '<span class="badge badge-i2i">i2i</span>' : '';
        
        return `
            <div class="${cardClass}" draggable="true" data-id="${item.id}" ondragstart="handleDragStart(event)" ondragover="handleDragOver(event)" ondrop="handleDrop(event)" ondragend="handleDragEnd(event)">
                <div class="queue-item-top">
                    <div class="queue-item-prompt" title="${item.prompt}">${item.prompt}</div>
                    <div class="queue-item-actions">
                        <button class="btn-card-action" onclick="moveQueueItem(${item.id}, 'up')" title="Move Up" ${idx === 0 ? 'disabled' : ''}>
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                        </button>
                        <button class="btn-card-action" onclick="moveQueueItem(${item.id}, 'down')" title="Move Down" ${idx === state.queue.length - 1 ? 'disabled' : ''}>
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>
                        </button>
                        ${item.status === 'pending' ? `
                        <button class="btn-card-action btn-edit" onclick="openEditModal(${item.id})" title="Edit Task">
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </button>
                        ` : ''}
                        <button class="btn-card-action btn-delete" onclick="deleteQueueItem(${item.id})" title="Delete Task">
                            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                        </button>
                    </div>
                </div>
                <div class="queue-item-bottom">
                    <div class="queue-item-models">
                        ${item.models.map(m => `<span class="model-tag">${m}</span>`).join('')}
                    </div>
                    <div class="queue-meta-info">
                        <span>L: ${lorasList}</span>
                        <span>Size: ${item.width}x${item.height}</span>
                        <span>Batch: ${item.batch_count}</span>
                        <span class="badge badge-${item.status}">${item.status}</span>
                        ${i2iBadge}
                        ${uploadBadge}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

async function deleteQueueItem(id) {
    if (confirm("Are you sure you want to delete this task?")) {
        try {
            await API.deleteQueue(id);
            await refreshQueue();
        } catch (e) {
            showToast("Failed to delete queue item", true);
        }
    }
}

async function moveQueueItem(id, direction) {
    const curIdx = state.queue.findIndex(item => item.id === id);
    if (curIdx === -1) return;
    
    let targetIdx = direction === 'up' ? curIdx - 1 : curIdx + 1;
    if (targetIdx < 0 || targetIdx >= state.queue.length) return;
    
    // Swap positions locally
    const items = [...state.queue];
    const temp = items[curIdx];
    items[curIdx] = items[targetIdx];
    items[targetIdx] = temp;
    
    // Update priorities
    const reorderPayload = items.map((item, idx) => ({
        id: item.id,
        priority: idx + 1
    }));
    
    try {
        await API.reorderQueue(reorderPayload);
        await refreshQueue();
    } catch (e) {
        showToast("Failed to reorder queue", true);
    }
}

// ==============================================================================
// DRAG AND DROP REORDERING
// ==============================================================================
let draggedElement = null;

function handleDragStart(e) {
    draggedElement = e.currentTarget;
    draggedElement.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedElement.getAttribute('data-id'));
}

function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    return false;
}

function handleDrop(e) {
    e.stopPropagation();
    e.preventDefault();
    
    const targetElement = e.currentTarget;
    if (draggedElement && draggedElement !== targetElement) {
        const listContainer = document.getElementById('queue-list-container');
        const cards = Array.from(listContainer.querySelectorAll('.queue-item-card'));
        
        const draggedIndex = cards.indexOf(draggedElement);
        const targetIndex = cards.indexOf(targetElement);
        
        if (draggedIndex < targetIndex) {
            listContainer.insertBefore(draggedElement, targetElement.nextSibling);
        } else {
            listContainer.insertBefore(draggedElement, targetElement);
        }
        
        // Save new order to server
        const updatedCards = Array.from(listContainer.querySelectorAll('.queue-item-card'));
        const reorderPayload = updatedCards.map((card, idx) => ({
            id: parseInt(card.getAttribute('data-id')),
            priority: idx + 1
        }));
        
        API.reorderQueue(reorderPayload).then(() => {
            refreshQueue();
        });
    }
}

function handleDragEnd(e) {
    if (draggedElement) {
        draggedElement.classList.remove('dragging');
        draggedElement = null;
    }
}

// ==============================================================================
// PROGRESS POLLING & CONTROL
// ==============================================================================
let lastWorkerRunning = null;
let lastTaskId = null;

async function pollStatus() {
    const dot = document.getElementById('server-status-dot');
    const text = document.getElementById('server-status-text');
    const toggleBtn = document.getElementById('btn-toggle-queue');
    const toggleText = document.getElementById('btn-toggle-text');
    const playIcon = toggleBtn.querySelector('.icon-play');
    const pauseIcon = toggleBtn.querySelector('.icon-pause');
    
    try {
        const data = await API.getStatus();
        state.status = data;
        
        // 1. Connection Indicator
        dot.className = "status-indicator connected";
        text.innerText = data.running ? "API Running (Queue Active)" : "API Connected (Queue Paused)";
        
        // 2. Play/Pause Button State
        if (data.running) {
            toggleBtn.className = "btn btn-secondary";
            toggleText.innerText = "Pause Queue";
            playIcon.classList.add('hidden');
            pauseIcon.classList.remove('hidden');
            dot.classList.add('processing');
        } else {
            toggleBtn.className = "btn btn-primary";
            toggleText.innerText = "Resume Queue";
            playIcon.classList.remove('hidden');
            pauseIcon.classList.add('hidden');
            dot.classList.remove('processing');
        }
        
        // 3. Active Task details
        const emptyState = document.getElementById('task-empty-state');
        const activeState = document.getElementById('task-active-state');
        
        if (data.current_task) {
            emptyState.classList.add('hidden');
            activeState.classList.remove('hidden');
            
            document.getElementById('active-prompt').innerText = data.current_task.prompt;
            document.getElementById('active-model').innerText = data.current_task.model;
            document.getElementById('active-seed').innerText = data.current_task.seed;
            document.getElementById('active-progress-text').innerText = `Image ${data.current_task.image_index}/${data.current_task.total_images}`;
            document.getElementById('active-progress-bar').style.width = `${data.current_task.percentage}%`;
            
            // Auto refresh queue when generating to update active class in lists
            refreshQueue();
        } else {
            emptyState.classList.remove('hidden');
            activeState.classList.add('hidden');
        }
        
        // 4. If queue worker just finished a job, trigger history reload
        const currentTaskId = data.current_task ? data.current_task.queue_id : null;
        if (lastTaskId !== null && currentTaskId === null) {
            // Task finished
            refreshQueue();
            refreshHistory();
        }
        lastTaskId = currentTaskId;
        
        if (data.error_message && data.error_message !== state.last_error) {
            showToast(data.error_message, true);
            state.last_error = data.error_message;
        }

    } catch (e) {
        dot.className = "status-indicator disconnected";
        text.innerText = "Offline - Check queue_manager.py server";
        toggleBtn.className = "btn btn-primary";
        toggleText.innerText = "Resume Queue";
        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');
    }
}

async function toggleQueue() {
    const action = state.status.running ? "pause" : "start";
    try {
        await API.control(action);
        await pollStatus();
        showToast(action === 'start' ? "Queue loop started!" : "Queue loop paused.");
    } catch (e) {
        showToast("Error toggling queue status", true);
    }
}

async function clearCompleted() {
    try {
        await API.control("clear_completed");
        await refreshQueue();
        showToast("Completed tasks cleared.");
    } catch (e) {
        showToast("Error clearing completed items", true);
    }
}

// ==============================================================================
// GALLERY HISTORY
// ==============================================================================
async function refreshHistory() {
    try {
        state.history = await API.getHistory();
        renderHistory();
    } catch (e) {
        console.error("Error fetching history:", e);
    }
}

function renderHistory() {
    const container = document.getElementById('gallery-container');
    const countEl = document.getElementById('gallery-count');
    
    countEl.innerText = `Total: ${state.history.length} images`;
    
    if (state.history.length === 0) {
        container.innerHTML = `
            <div class="empty-gallery">
                <p>No images generated yet. Start the queue to populate the gallery.</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = state.history.map(item => {
        if (item.status === 'failed') {
            return `
                <div class="gallery-item-card" onclick="openImageDetails(${item.id})">
                    <div class="gallery-card-fail">
                        <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        <strong>Generation Failed</strong>
                        <p>${item.error_message ? item.error_message.substring(0, 40) + '...' : 'Unknown Error'}</p>
                    </div>
                    <div class="gallery-item-overlay">
                        <div class="gallery-item-prompt">${item.prompt}</div>
                        <div class="gallery-item-model">${item.model}</div>
                        <div class="gallery-item-seed">Failed</div>
                    </div>
                </div>
            `;
        }
        
        return `
            <div class="gallery-item-card" onclick="openImageDetails(${item.id})">
                <img class="gallery-img" src="/outputs/${item.filename}" alt="Image" loading="lazy">
                <div class="gallery-item-overlay">
                    <div class="gallery-item-prompt">${item.prompt}</div>
                    <div class="gallery-item-model">${item.model}</div>
                    <div class="gallery-item-seed">Seed: ${item.seed}</div>
                </div>
            </div>
        `;
    }).join('');
}

// ==============================================================================
// DETAILED MODALS & UTILS
// ==============================================================================
function openImageDetails(historyId) {
    const item = state.history.find(h => h.id === historyId);
    if (!item) return;
    
    document.getElementById('image-modal-title').innerText = item.status === 'success' ? `Seed: ${item.seed}` : 'Generation Failed';
    
    const imgEl = document.getElementById('image-modal-img');
    if (item.status === 'success') {
        imgEl.src = `/outputs/${item.filename}`;
        imgEl.style.display = 'block';
    } else {
        imgEl.style.display = 'none';
    }
    
    document.getElementById('image-info-prompt').innerText = item.prompt;
    document.getElementById('image-info-negative').innerText = item.negative_prompt || 'None';
    document.getElementById('image-info-model').innerText = item.model;
    document.getElementById('image-info-seed').innerText = item.seed;
    document.getElementById('image-info-steps').innerText = item.steps || 'N/A';
    document.getElementById('image-info-cfg').innerText = item.cfg_scale || 'N/A';
    document.getElementById('image-info-dim').innerText = `${item.width}x${item.height}`;
    document.getElementById('image-info-date').innerText = new Date(item.created_at).toLocaleString();
    
    // LoRA rendering
    const lorasContainer = document.getElementById('image-info-loras');
    if (item.loras && item.loras.length > 0) {
        lorasContainer.innerHTML = item.loras.map(l => `
            <span class="tag-lora">${l.file} (${l.weight})</span>
        `).join('');
    } else {
        lorasContainer.innerHTML = '<span class="tag-lora" style="background: rgba(255,255,255,0.03); color: var(--text-dim)">None</span>';
    }
    
    // Requeue action
    const btnRequeue = document.getElementById('btn-modal-requeue');
    btnRequeue.onclick = () => {
        reuseParameters(item);
        toggleModal('image-modal', false);
    };
    
    // Send to img2img action
    const btnSendI2I = document.getElementById('btn-modal-send-i2i');
    if (item.status === 'success' && item.filename && !item.civitai_url) {
        btnSendI2I.classList.remove('hidden');
        btnSendI2I.onclick = () => {
            sendToImg2Img(item);
            toggleModal('image-modal', false);
        };
    } else {
        btnSendI2I.classList.add('hidden');
    }
    
    // File Link (only shown when file exists locally, hidden if uploaded to civitai)
    const btnOpenFolder = document.getElementById('btn-modal-open-folder');
    const btnCivitai = document.getElementById('btn-modal-civitai');
    if (item.civitai_url) {
        btnCivitai.href = item.civitai_url;
        btnCivitai.classList.remove('hidden');
        btnOpenFolder.classList.add('hidden');
    } else if (item.status === 'success' && item.filename) {
        btnOpenFolder.href = `/outputs/${item.filename}`;
        btnOpenFolder.classList.remove('hidden');
        btnCivitai.classList.add('hidden');
    } else {
        btnOpenFolder.classList.add('hidden');
        btnCivitai.classList.add('hidden');
    }
    
    toggleModal('image-modal', true);
}

async function sendToImg2Img(item) {
    try {
        // Fetch the image to get base64
        const response = await fetch(`/outputs/${item.filename}`);
        const blob = await response.blob();
        
        const reader = new FileReader();
        reader.onloadend = () => {
            const base64data = reader.result;
            // Update state
            refImageBase64.create = base64data.split(',')[1];
            
            // Update UI for the reference image dropzone
            container.querySelector('.ref-image-thumb').src = base64data;
            container.querySelector('.dropzone-idle').classList.add('hidden');
            container.querySelector('.dropzone-preview').classList.remove('hidden');
            container.querySelector('.denoising-group').classList.remove('hidden');
            
            // Also copy the parameters to make it easy to start modifying
            reuseParameters(item);
            
            showToast("Sent to img2img and parameters copied!");
        };
        reader.readAsDataURL(blob);
    } catch (e) {
        showToast("Failed to load image for img2img: " + e.message, true);
    }
}

function reuseParameters(item) {
    // Populate form inputs
    document.querySelector('#create-form-container .input-prompt').value = item.prompt;
    document.querySelector('#create-form-container .input-negative-prompt').value = item.negative_prompt || '';
    document.querySelector('#create-form-container .input-steps').value = item.steps || 8;
    document.querySelector('#create-form-container .input-cfg-scale').value = item.cfg_scale || 1.0;
    document.querySelector('#create-form-container .input-seed').value = item.seed;
    
    // Set custom resolution and slider match
    setSizeStateFromDimensions(item.width, item.height);
    
    // Select base model
    const modelCheckboxes = document.querySelectorAll('#create-form-container input[name="model"]');
    modelCheckboxes.forEach(cb => {
        cb.checked = (cb.value === item.model);
    });
    
    // Reset and select LoRAs
    const loraRows = document.querySelectorAll('#create-form-container .lora-item-row');
    loraRows.forEach(row => {
        row.classList.remove('active');
        const cb = row.querySelector('input[name="lora-enable"]');
        const slider = row.querySelector('.lora-weight-slider');
        const valSpan = row.querySelector('.lora-weight-value');
        if (cb && slider && valSpan) {
            cb.checked = false;
            
            // Check if this LoRA was active in the historical item
            const foundLora = item.loras.find(l => l.file === cb.value);
            if (foundLora) {
                cb.checked = true;
                row.classList.add('active');
                slider.value = foundLora.weight;
                valSpan.innerText = parseFloat(foundLora.weight).toFixed(1);
            }
        }
    });
    
    showToast("Parameters copied to Creator Form!");
}

function toggleModal(modalId, forceState = null) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    
    if (forceState !== null) {
        if (forceState) modal.classList.remove('hidden');
        else modal.classList.add('hidden');
    } else {
        modal.classList.toggle('hidden');
    }
}

// Simple Toast Notification
function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.bottom = '24px';
    toast.style.right = '24px';
    toast.style.background = isError ? 'var(--accent-red)' : 'var(--primary-grad)';
    toast.style.color = '#fff';
    toast.style.padding = '12px 24px';
    toast.style.borderRadius = 'var(--radius-sm)';
    toast.style.boxShadow = 'var(--shadow-md)';
    toast.style.fontSize = '14px';
    toast.style.fontWeight = '600';
    toast.style.zIndex = '9999';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    toast.innerText = message;
    
    document.body.appendChild(toast);
    
    // Trigger animation
    setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    }, 10);
    
    // Remove toast
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ==============================================================================
// EDIT QUEUE ITEM SYSTEM
// ==============================================================================
let editSizeState = {
    ratio: '1:1',
    size: 1024
};

let currentEditingItemId = null;


function openEditModal(itemId) {
    const item = state.queue.find(q => q.id === itemId);
    if (!item) return;
    
    if (item.status !== 'pending') {
        showToast("Only pending items can be edited!", true);
        return;
    }
    
    currentEditingItemId = itemId;
    
    // Populate form fields
    document.querySelector('#edit-form-container .input-prompt').value = item.prompt;
    document.querySelector('#edit-form-container .input-negative-prompt').value = item.negative_prompt || '';
    document.querySelector('#edit-form-container .input-steps').value = item.steps || 8;
    document.querySelector('#edit-form-container .input-cfg-scale').value = item.cfg_scale || 1.0;
    document.querySelector('#edit-form-container .input-batch-count').value = item.batch_count || 2;
    document.querySelector('#edit-form-container .input-seed').value = item.seed;
    
    const autoUploadEl = document.querySelector('#edit-form-container .input-auto-upload');
    if (autoUploadEl) autoUploadEl.checked = !!item.auto_upload;
    
    // Dynamically populate models & loras lists for the edit modal
    populateModelsAndLoras(document.getElementById('edit-form-container'), 'edit');
    
    // Check base models checkmarks
    const modelCheckboxes = document.querySelectorAll('#edit-form-container input[name="model"]');
    modelCheckboxes.forEach(cb => {
        cb.checked = item.models.includes(cb.value);
    });
    
    // Check and set LoRAs checkboxes & weight sliders
    item.loras.forEach(savedLora => {
        const cleaned = cleanId(savedLora.file);
        const row = document.querySelector(`#edit-form-container .lora-item-row[data-id="${cleaned}"]`);
        if (row) {
            const cb = row.querySelector('input[name="lora-enable"]');
            const slider = row.querySelector('.lora-weight-slider');
            const valSpan = row.querySelector('.lora-weight-value');
            
            if (cb && slider) {
                cb.checked = true;
                row.classList.add('active');
                slider.value = savedLora.weight;
                if (valSpan) valSpan.innerText = parseFloat(savedLora.weight).toFixed(1);
            }
        }
    });
    
    // Set aspect ratio and image size
    setSizeStateFromDimensions(item.width, item.height, 'edit');
    
    // Restore reference image if present
    if (item.init_image) {
        refImageBase64.edit = item.init_image;
        document.querySelector('#edit-form-container .ref-image-thumb').src = 'data:image/png;base64,' + item.init_image;
        document.querySelector('#edit-form-container .dropzone-idle').classList.add('hidden');
        document.querySelector('#edit-form-container .dropzone-preview').classList.remove('hidden');
        document.querySelector('#edit-form-container .denoising-group').classList.remove('hidden');
        document.querySelector('#edit-form-container .input-denoising-strength').value = item.denoising_strength || 0.6;
        document.querySelector('#edit-form-container .denoising-value-display').textContent = parseFloat(item.denoising_strength || 0.6).toFixed(2);
    } else {
        clearRefImage('edit', { stopPropagation: () => {} });
    }
    
    toggleModal('edit-modal', true);
}

async function saveQueueItemUpdate() {
    if (!currentEditingItemId) return;
    
    const prompt = document.querySelector('#edit-form-container .input-prompt').value.trim();
    const negativePrompt = document.querySelector('#edit-form-container .input-negative-prompt').value.trim();
    const width = parseInt(document.querySelector('#edit-form-container .input-width').value);
    const height = parseInt(document.querySelector('#edit-form-container .input-height').value);
    const steps = parseInt(document.querySelector('#edit-form-container .input-steps').value);
    const cfgScale = parseFloat(document.querySelector('#edit-form-container .input-cfg-scale').value);
    const batchCount = parseInt(document.querySelector('#edit-form-container .input-batch-count').value);
    const seed = parseInt(document.querySelector('#edit-form-container .input-seed').value);

    // Selected Models
    const modelCheckedElements = document.querySelectorAll('#edit-form-container input[name="model"]:checked');
    const selectedModels = Array.from(modelCheckedElements).map(el => el.value);
    
    if (selectedModels.length === 0) {
        showToast("Please select at least one Base Model!", true);
        return;
    }

    // Selected LoRAs
    const selectedLoras = [];
    const loraRows = document.querySelectorAll('#edit-form-container .lora-item-row.active');
    loraRows.forEach(row => {
        const checkbox = row.querySelector('input[name="lora-enable"]');
        const slider = row.querySelector('.lora-weight-slider');
        if (checkbox && slider && checkbox.checked) {
            selectedLoras.push({
                file: checkbox.value,
                weight: parseFloat(slider.value)
            });
        }
    });

    const updatedTaskData = {
        prompt,
        negative_prompt: negativePrompt,
        models: selectedModels,
        steps,
        cfg_scale: cfgScale,
        width,
        height,
        loras: selectedLoras,
        batch_count: batchCount,
        seed,
        auto_upload: document.querySelector('#edit-form-container .input-auto-upload')?.checked || false,
        init_image: refImageBase64.edit || null,
        denoising_strength: refImageBase64.edit ? parseFloat(document.querySelector('#edit-form-container .input-denoising-strength').value) : 0.6
    };

    try {
        const res = await API.updateQueue(currentEditingItemId, updatedTaskData);
        if (res.status === 'success') {
            showToast("Queue item updated successfully!");
            toggleModal('edit-modal', false);
            await refreshQueue();
        } else {
            showToast("Failed to update queue item: " + (res.detail || "Unknown error"), true);
        }
    } catch (err) {
        showToast("Failed to update queue item: " + err.message, true);
    }
}

// ==============================================================================
// EVENT LISTENERS
// ==============================================================================
function setupEventListeners() {
    // Helper to safely bind click events
    function safeAddListener(id, event, callback) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener(event, callback);
        } else {
            console.warn(`Element with id '${id}' not found for event '${event}'`);
        }
    }

    // Task submission
    safeAddListener('task-form', 'submit', handleTaskFormSubmit);
    
    // Auto-save form inputs
    const taskForm = document.getElementById('task-form');
    if (taskForm) {
        taskForm.addEventListener('input', saveParamsToLocalStorage);
        taskForm.addEventListener('change', saveParamsToLocalStorage);
    }
    


    // Control bar
    safeAddListener('btn-toggle-queue', 'click', toggleQueue);
    safeAddListener('btn-clear-completed', 'click', clearCompleted);
    
    // Settings modal triggers
    safeAddListener('btn-settings', 'click', () => toggleModal('settings-modal', true));
    safeAddListener('btn-close-settings', 'click', () => toggleModal('settings-modal', false));
    safeAddListener('btn-save-settings', 'click', saveSettings);
    
    // Image details close
    safeAddListener('btn-close-image', 'click', () => toggleModal('image-modal', false));

    // Edit modal triggers
    safeAddListener('btn-close-edit', 'click', () => toggleModal('edit-modal', false));
    safeAddListener('btn-cancel-edit', 'click', () => toggleModal('edit-modal', false));
    safeAddListener('btn-save-edit', 'click', saveQueueItemUpdate);


    
    // Click outside to close modals
    window.addEventListener('click', (e) => {
        const settingsModal = document.getElementById('settings-modal');
        const imageModal = document.getElementById('image-modal');
        const editModal = document.getElementById('edit-modal');
        if (e.target === settingsModal) toggleModal('settings-modal', false);
        if (e.target === imageModal) toggleModal('image-modal', false);
        if (e.target === editModal) toggleModal('edit-modal', false);
    });
}
// ============================================================================
// STORAGE MANAGER LOGIC
// ============================================================================
let storageRefreshInterval = null;

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

async function refreshStorageData() {
    try {
        const data = await API.getStorage();
        document.getElementById('size-local-outputs').textContent = formatBytes(data.outputs_size_bytes);
        document.getElementById('size-dt-db').textContent = formatBytes(data.db_size_bytes);
        
        const btnVacuum = document.getElementById('btn-vacuum-db');
        const vacuumProgress = document.getElementById('vacuum-progress');
        
        if (data.vacuum_running) {
            btnVacuum.classList.add('hidden');
            vacuumProgress.classList.remove('hidden');
        } else {
            btnVacuum.classList.remove('hidden');
            vacuumProgress.classList.add('hidden');
        }
    } catch (e) {
        console.error("Failed to fetch storage stats", e);
    }
}

document.getElementById('btn-storage').addEventListener('click', () => {
    toggleModal('storage-modal', true);
    refreshStorageData();
    storageRefreshInterval = setInterval(refreshStorageData, 3000);
});

document.getElementById('btn-close-storage').addEventListener('click', () => {
    toggleModal('storage-modal', false);
    if (storageRefreshInterval) {
        clearInterval(storageRefreshInterval);
        storageRefreshInterval = null;
    }
});

document.getElementById('btn-clean-local').addEventListener('click', async () => {
    const btn = document.getElementById('btn-clean-local');
    btn.disabled = true;
    btn.textContent = 'Cleaning...';
    try {
        const res = await API.cleanLocal();
        showToast(`Cleared ${res.deleted_count} unused images from local folder.`);
        await refreshStorageData();
    } catch (e) {
        showToast(`Failed to clean local storage: ${e.message}`, true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Clean Local Outputs';
    }
});

document.getElementById('btn-vacuum-db').addEventListener('click', async () => {
    if (!confirm("Have you completely closed the Draw Things app? Vacuuming while it is running can corrupt the database.")) return;
    
    try {
        await API.vacuumDb();
        showToast("Vacuum started in the background. Do not close this window or start Draw Things yet.");
        refreshStorageData();
    } catch (e) {
        showToast(`Failed to start vacuum: ${e.message}`, true);
    }
});
