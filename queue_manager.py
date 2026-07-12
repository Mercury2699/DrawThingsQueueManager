#!/usr/bin/env python3
# /// script
# dependencies = [
#   "fastapi",
#   "uvicorn",
#   "requests",
#   "pillow",
# ]
# ///

import os
import sys
import json
import base64
import sqlite3
import threading
import time
import random
import requests
from io import BytesIO
from PIL import Image
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

# ==============================================================================
# CONFIGURATION & CONSTANTS
# ==============================================================================
API_URL = "http://127.0.0.1:7860/sdapi/v1/txt2img"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
DB_PATH = os.path.join(BASE_DIR, "queue_manager.db")
STATIC_DIR = os.path.join(BASE_DIR, "static")

# macOS Draw Things Models path
DRAW_THINGS_MODELS_DIR = os.path.expanduser(
    "~/Library/Containers/com.liuliu.draw-things/Data/Documents/Models"
)

# Ensure directories exist
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(STATIC_DIR, exist_ok=True)

# ==============================================================================
# DATABASE SETUP
# ==============================================================================
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    
    # Queue table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            prompt TEXT NOT NULL,
            negative_prompt TEXT,
            models TEXT NOT NULL, -- JSON array of model names
            steps INTEGER DEFAULT 8,
            cfg_scale REAL DEFAULT 1.0,
            width INTEGER DEFAULT 512,
            height INTEGER DEFAULT 512,
            loras TEXT DEFAULT '[]', -- JSON array of {"file": str, "weight": float}
            batch_count INTEGER DEFAULT 1,
            seed INTEGER DEFAULT -1,
            status TEXT DEFAULT 'pending', -- pending, processing, completed, failed
            priority INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            auto_upload INTEGER DEFAULT 0,
            upload_status TEXT DEFAULT NULL -- NULL, uploading, uploaded, upload_failed
        )
    """)
    
    # History table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            queue_id INTEGER,
            prompt TEXT NOT NULL,
            negative_prompt TEXT,
            model TEXT NOT NULL,
            seed INTEGER NOT NULL,
            steps INTEGER,
            cfg_scale REAL,
            width INTEGER,
            height INTEGER,
            loras TEXT,
            filename TEXT,
            status TEXT, -- success, failed
            error_message TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Migrations: add new columns if they don't exist yet
    migrations = [
        "ALTER TABLE history ADD COLUMN negative_prompt TEXT",
        "ALTER TABLE history ADD COLUMN civitai_url TEXT",
        "ALTER TABLE queue ADD COLUMN auto_upload INTEGER DEFAULT 0",
        "ALTER TABLE queue ADD COLUMN upload_status TEXT DEFAULT NULL",
    ]
    for sql in migrations:
        try:
            cursor.execute(sql)
        except sqlite3.OperationalError:
            pass  # Column already exists
    
    # Settings table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    
    # Insert default settings if not exists
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('draw_things_api', ?)", (API_URL,))
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('civitai_cookies', '')")
    cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('civitai_model_mapping', '')")
    
    conn.commit()
    conn.close()

init_db()

# ==============================================================================
# Pydantic Schemas
# ==============================================================================
class LoraConfig(BaseModel):
    file: str
    weight: float

class QueueItemCreate(BaseModel):
    prompt: str
    negative_prompt: Optional[str] = ""
    models: List[str]
    steps: Optional[int] = 8
    cfg_scale: Optional[float] = 1.0
    width: Optional[int] = 512
    height: Optional[int] = 512
    loras: Optional[List[LoraConfig]] = []
    batch_count: Optional[int] = 1
    seed: Optional[int] = -1
    auto_upload: Optional[bool] = False

class ControlAction(BaseModel):
    action: str # start, pause, clear_completed, clear_all

class ReorderItem(BaseModel):
    id: int
    priority: int

class ReorderRequest(BaseModel):
    items: List[ReorderItem]

# ==============================================================================
# BACKGROUND WORKER STATE & LOOP
# ==============================================================================
class QueueWorker:
    def __init__(self):
        self.running = False
        self.current_task: Optional[Dict[str, Any]] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.error_message: Optional[str] = None
        self.active_queue_id: Optional[int] = None
        self.active_total_images: int = 0

    def start(self):
        with self._lock:
            if not self.running:
                self.running = True
                self.error_message = None
                self._thread = threading.Thread(target=self._run_loop, daemon=True)
                self._thread.start()

    def pause(self):
        with self._lock:
            self.running = False

    def _run_loop(self):
        while True:
            # Check if running flag is false
            with self._lock:
                if not self.running:
                    self.current_task = None
                    break

            conn = get_db()
            cursor = conn.cursor()
            
            # Fetch next pending item (highest priority first, then oldest)
            cursor.execute("""
                SELECT * FROM queue 
                WHERE status = 'pending' OR status = 'processing'
                ORDER BY priority ASC, created_at ASC LIMIT 1
            """)
            item = cursor.fetchone()
            
            if not item:
                conn.close()
                self.current_task = None
                time.sleep(1.0)
                continue
                
            item_id = item['id']
            prompt = item['prompt']
            negative_prompt = item['negative_prompt']
            models = json.loads(item['models'])
            steps = item['steps']
            cfg_scale = item['cfg_scale']
            width = item['width']
            height = item['height']
            loras = json.loads(item['loras'])
            batch_count = item['batch_count']
            start_seed = item['seed']
            
            # Update status to processing if it was pending
            if item['status'] == 'pending':
                cursor.execute("UPDATE queue SET status = 'processing' WHERE id = ?", (item_id,))
                conn.commit()
            
            total_images = len(models) * batch_count
            self.active_queue_id = item_id
            self.active_total_images = total_images
            
            # Get api address from settings
            cursor.execute("SELECT value FROM settings WHERE key = 'draw_things_api'")
            setting_row = cursor.fetchone()
            api_endpoint = setting_row['value'] if setting_row else API_URL
            
            conn.close()
            
            success_count = 0
            failed_count = 0
            
            # Start generator loop
            task_aborted = False
            
            for m_idx, model in enumerate(models):
                if task_aborted:
                    break
                    
                for b_idx in range(batch_count):
                    # Check run status again
                    with self._lock:
                        if not self.running:
                            task_aborted = True
                            break

                    # Check if the queue item was deleted while processing
                    conn_check = get_db()
                    cur_check = conn_check.cursor()
                    cur_check.execute("SELECT id, status FROM queue WHERE id = ?", (item_id,))
                    exists = cur_check.fetchone()
                    conn_check.close()
                    if not exists:
                        task_aborted = True
                        break

                    current_image_idx = m_idx * batch_count + b_idx
                    seed = start_seed if start_seed != -1 else random.randint(0, 2**32 - 1)
                    if start_seed != -1:
                        seed = start_seed + b_idx

                    # Update current active task state for dashboard progress
                    self.current_task = {
                        "queue_id": item_id,
                        "prompt": prompt,
                        "model": model,
                        "seed": seed,
                        "image_index": current_image_idx + 1,
                        "total_images": total_images,
                        "percentage": int((current_image_idx / total_images) * 100)
                    }
                    
                    # Call API
                    success = self._generate_and_save(
                        api_endpoint=api_endpoint,
                        queue_id=item_id,
                        prompt=prompt,
                        negative_prompt=negative_prompt,
                        model=model,
                        seed=seed,
                        steps=steps,
                        cfg_scale=cfg_scale,
                        width=width,
                        height=height,
                        loras=loras
                    )
                    
                    if success:
                        success_count += 1
                    else:
                        failed_count += 1
                        # If API is completely down, let's pause queue
                        if self.error_message and ("ConnectionRefusedError" in self.error_message or "ConnectionError" in self.error_message):
                            self.running = False
                            task_aborted = True
                            break

                    # Add a 2-second cooldown to let the GPU clear and write files
                    time.sleep(2.0)
            
            if task_aborted:
                # If we paused, mark the queue item back to pending (so we can resume or re-run)
                conn = get_db()
                cursor = conn.cursor()
                cursor.execute("SELECT status FROM queue WHERE id = ?", (item_id,))
                status_row = cursor.fetchone()
                if status_row and status_row['status'] == 'processing':
                    cursor.execute("UPDATE queue SET status = 'pending' WHERE id = ?", (item_id,))
                    conn.commit()
                conn.close()
                self.current_task = None
                continue

            # Update final status of queue item
            final_status = 'completed' if failed_count == 0 else ('failed' if success_count == 0 else 'completed')
            
            # Show 100% completion in state for a brief moment
            if self.current_task:
                self.current_task["percentage"] = 100
                self.current_task["image_index"] = total_images
            
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("UPDATE queue SET status = ? WHERE id = ?", (final_status, item_id))
            conn.commit()
            conn.close()
            
            # Auto-upload: if enabled and at least one image succeeded, trigger background upload
            if item['auto_upload'] and success_count > 0:
                conn = get_db()
                cursor = conn.cursor()
                cursor.execute(
                    "SELECT filename FROM history WHERE queue_id = ? AND status = 'success' AND filename IS NOT NULL",
                    (item_id,)
                )
                rows = cursor.fetchall()
                conn.close()
                filepaths = [os.path.join(OUTPUT_DIR, r['filename']) for r in rows]
                if filepaths:
                    upload_thread = threading.Thread(
                        target=self._upload_completed_task,
                        args=(item_id, filepaths),
                        daemon=True
                    )
                    upload_thread.start()
            
            time.sleep(0.5)
            self.current_task = None
            time.sleep(0.5)

    def _generate_and_save(self, api_endpoint, queue_id, prompt, negative_prompt, model, seed, steps, cfg_scale, width, height, loras):
        # Format LoRAs for Draw Things API
        formatted_loras = []
        for lora in loras:
            lora_file = lora["file"]
            # Apply lowercase mapping if needed for manual filenames (compatibility with legacy format)
            if not lora_file.lower().endswith("_lora_f16.ckpt") and (lora_file.endswith(".safetensors") or lora_file.endswith(".ckpt")):
                lora_internal_name = lora_file.lower()
                if lora_internal_name.endswith(".safetensors"):
                    lora_internal_name = lora_internal_name[:-12] + "_lora_f16.ckpt"
                elif lora_internal_name.endswith(".ckpt"):
                    lora_internal_name = lora_internal_name[:-5] + "_lora_f16.ckpt"
            else:
                lora_internal_name = lora_file

            formatted_loras.append({
                "mode": "all",
                "file": lora_internal_name,
                "weight": lora["weight"]
            })

        payload = {
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "seed": seed,
            "steps": steps,
            "cfg_scale": cfg_scale,
            "width": width,
            "height": height,
            "model": model,
            "loras": formatted_loras,
            "batch_size": 1,
            "n_iter": 1
        }

        filename = f"dt_{int(time.time())}_{seed}.png"
        filepath = os.path.join(OUTPUT_DIR, filename)

        last_error = ""
        response_data = None
        
        # Check if queue loop was paused/stopped by user
        with self._lock:
            if not self.running:
                last_error = "Task paused by user."

        if not last_error:
            try:
                print("  -> Sending API request...")
                response = requests.post(
                    api_endpoint, 
                    json=payload, 
                    headers={"Content-Type": "application/json"}, 
                    timeout=1800  # 30 minutes timeout
                )
                
                if response.status_code != 200:
                    last_error = f"API error: HTTP {response.status_code} - {response.text[:200]}"
                    print(f"  [WARNING] Generation failed: {last_error}")
                else:
                    data = response.json()
                    if "images" not in data or not data["images"]:
                        last_error = "Draw Things returned an empty images list (app may be busy or generation cancelled)."
                        print(f"  [WARNING] Generation failed: {last_error}")
                    else:
                        # Success!
                        response_data = data

            except requests.exceptions.Timeout:
                last_error = "Timeout: Generation request took longer than 30 minutes."
                print(f"  [WARNING] Generation failed: {last_error}")
            except requests.exceptions.ConnectionError:
                last_error = "ConnectionError: Could not connect to Draw Things API. Is it running?"
                print(f"  [WARNING] Generation failed: {last_error}")
            except Exception as e:
                last_error = f"Exception: {str(e)}"
                print(f"  [WARNING] Generation failed: {last_error}")

        if not response_data:
            # Generation failed
            self.error_message = last_error
            self._save_history_fail(queue_id, prompt, negative_prompt, model, seed, steps, cfg_scale, width, height, loras, last_error)
            return False

        # Save base64 image to file
        try:
            img_data = base64.b64decode(response_data["images"][0])
            img = Image.open(BytesIO(img_data))
            img.save(filepath)

            # Insert history success
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO history (queue_id, prompt, negative_prompt, model, seed, steps, cfg_scale, width, height, loras, filename, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success')
            """, (queue_id, prompt, negative_prompt, model, seed, steps, cfg_scale, width, height, json.dumps(loras), filename))
            conn.commit()
            conn.close()
            return True
        except Exception as e:
            err_msg = f"Failed to save image file: {str(e)}"
            self.error_message = err_msg
            self._save_history_fail(queue_id, prompt, negative_prompt, model, seed, steps, cfg_scale, width, height, loras, err_msg)
            return False

    def _upload_completed_task(self, queue_id: int, filepaths: list):
        """Run upload_to_civitai.py as a subprocess for the given files.
        Parses the UPLOAD_RESULT_JSON output, stores civitai_url in history,
        then deletes the local PNG files to free disk space."""
        import subprocess
        
        # Read upload config from settings
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM settings WHERE key IN ('civitai_cookies', 'civitai_model_mapping')")
        settings_rows = {r['key']: r['value'] for r in cursor.fetchall()}
        conn.close()
        
        cookies_path = settings_rows.get('civitai_cookies', '').strip()
        mapping_path = settings_rows.get('civitai_model_mapping', '').strip()
        
        if not cookies_path or not os.path.exists(cookies_path):
            print(f"[AUTO-UPLOAD] Skipping queue {queue_id}: civitai_cookies not configured or file missing ({cookies_path!r})")
            conn = get_db()
            conn.execute("UPDATE queue SET upload_status = 'upload_failed' WHERE id = ?", (queue_id,))
            conn.commit(); conn.close()
            return
        
        # Mark as uploading
        conn = get_db()
        conn.execute("UPDATE queue SET upload_status = 'uploading' WHERE id = ?", (queue_id,))
        conn.commit(); conn.close()
        
        upload_script = os.path.join(BASE_DIR, 'upload_to_civitai.py')
        cmd = [
            'uv', 'run',
            '--with', 'requests',
            '--with', 'pillow',
            '--with', 'blurhash-python',
            upload_script,
            '--cookies', cookies_path,
            '--group-by-prompt',
            '--output-json',
            '--image', *filepaths,
        ]
        if mapping_path and os.path.exists(mapping_path):
            cmd += ['--model-mapping', mapping_path]
        
        print(f"[AUTO-UPLOAD] Starting upload for queue {queue_id} ({len(filepaths)} files)...")
        
        upload_result = {}
        try:
            proc = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=3600  # 1 hour max
            )
            # Print subprocess output to console
            for line in proc.stdout.splitlines():
                print(f"[AUTO-UPLOAD] {line}")
                # Parse the machine-readable result line
                if line.startswith('UPLOAD_RESULT_JSON:'):
                    try:
                        upload_result = json.loads(line[len('UPLOAD_RESULT_JSON:'):])
                    except json.JSONDecodeError as e:
                        print(f"[AUTO-UPLOAD] Failed to parse result JSON: {e}")
            if proc.returncode != 0:
                print(f"[AUTO-UPLOAD] Upload script exited with code {proc.returncode}")
                for line in proc.stderr.splitlines():
                    print(f"[AUTO-UPLOAD] STDERR: {line}")
        except subprocess.TimeoutExpired:
            print(f"[AUTO-UPLOAD] Upload timed out for queue {queue_id}")
        except Exception as e:
            print(f"[AUTO-UPLOAD] Error running upload script: {e}")
        
        if not upload_result:
            conn = get_db()
            conn.execute("UPDATE queue SET upload_status = 'upload_failed' WHERE id = ?", (queue_id,))
            conn.commit(); conn.close()
            return
        
        # Store civitai_url in history rows and delete local files
        deleted_count = 0
        conn = get_db()
        cursor = conn.cursor()
        for abs_path, post_url in upload_result.items():
            filename = os.path.basename(abs_path)
            cursor.execute(
                "UPDATE history SET civitai_url = ? WHERE queue_id = ? AND filename = ?",
                (post_url, queue_id, filename)
            )
            # Delete the local file now that it's safely on CivitAI
            try:
                if os.path.exists(abs_path):
                    os.remove(abs_path)
                    deleted_count += 1
            except OSError as e:
                print(f"[AUTO-UPLOAD] Could not delete {abs_path}: {e}")
        conn.commit()
        conn.close()
        
        # Mark upload complete
        conn = get_db()
        conn.execute("UPDATE queue SET upload_status = 'uploaded' WHERE id = ?", (queue_id,))
        conn.commit(); conn.close()
        
        print(f"[AUTO-UPLOAD] Done for queue {queue_id}: {len(upload_result)} posts published, {deleted_count} local files deleted.")

    def _save_history_fail(self, queue_id, prompt, negative_prompt, model, seed, steps, cfg_scale, width, height, loras, error_message):
        try:
            conn = get_db()
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO history (queue_id, prompt, negative_prompt, model, seed, steps, cfg_scale, width, height, loras, filename, status, error_message)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'failed', ?)
            """, (queue_id, prompt, negative_prompt, model, seed, steps, cfg_scale, width, height, json.dumps(loras), error_message))
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"Error saving failed history: {e}")

worker = QueueWorker()

# ==============================================================================
# FASTAPI APP
# ==============================================================================
app = FastAPI(title="Draw Things Queue Manager")

# Serve generated outputs
app.mount("/outputs", StaticFiles(directory=OUTPUT_DIR), name="outputs")

# Helper to scan base models & LoRAs in the Draw Things Models Directory
@app.get("/api/models")
def list_available_models():
    models_list = []
    loras_list = []

    if os.path.exists(DRAW_THINGS_MODELS_DIR):
        try:
            files = os.listdir(DRAW_THINGS_MODELS_DIR)
            for f in files:
                if f.startswith('.'):
                    continue
                filepath = os.path.join(DRAW_THINGS_MODELS_DIR, f)
                if not os.path.isfile(filepath):
                    continue

                size_mb = os.path.getsize(filepath) / (1024 * 1024)
                
                # Heuristics:
                # 1. Filenames containing "_lora_" are LoRAs
                # 2. Files smaller than 500MB are likely LoRAs or VAEs
                # 3. Files larger than 1GB and ending in .ckpt / .safetensors are base models
                f_lower = f.lower()
                if "_lora_" in f_lower or "lora" in f_lower or size_mb < 500:
                    # Exclude typical VAEs or tiny config files
                    if not f_lower.endswith(".json") and not f_lower.endswith("-tensordata") and not f_lower.endswith(".txt"):
                        loras_list.append(f)
                else:
                    if f_lower.endswith(".ckpt") or f_lower.endswith(".safetensors"):
                        models_list.append(f)
        except Exception as e:
            print(f"Error listing models directory: {e}")

    # Sort alphabetically
    models_list.sort()
    loras_list.sort()
    
    # Fallback to defaults from the prompt if folder is empty or not found
    if not models_list:
        models_list = ["z_image_turbo_1.0_q8p.ckpt", "moody_pro_mix_v13_f16.ckpt", "moody_pro_mix_v13_q8p.ckpt"]
    if not loras_list:
        loras_list = ["mercuryzi_no_adaln_lora_f16.ckpt"]

    return {
        "models": models_list,
        "loras": loras_list,
        "models_dir": DRAW_THINGS_MODELS_DIR,
        "models_dir_exists": os.path.exists(DRAW_THINGS_MODELS_DIR)
    }

# Queue REST operations
@app.get("/api/queue")
def get_queue():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM queue ORDER BY priority ASC, created_at ASC")
    rows = cursor.fetchall()
    conn.close()
    
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "prompt": r["prompt"],
            "negative_prompt": r["negative_prompt"],
            "models": json.loads(r["models"]),
            "steps": r["steps"],
            "cfg_scale": r["cfg_scale"],
            "width": r["width"],
            "height": r["height"],
            "loras": json.loads(r["loras"]),
            "batch_count": r["batch_count"],
            "seed": r["seed"],
            "status": r["status"],
            "priority": r["priority"],
            "created_at": r["created_at"],
            "auto_upload": bool(r["auto_upload"]),
            "upload_status": r["upload_status"],
        })
    return result

@app.post("/api/queue")
def add_to_queue(item: QueueItemCreate):
    conn = get_db()
    cursor = conn.cursor()
    
    # Get highest priority currently in the queue
    cursor.execute("SELECT MAX(priority) as max_p FROM queue")
    row = cursor.fetchone()
    next_priority = (row["max_p"] or 0) + 1
    
    cursor.execute("""
        INSERT INTO queue (prompt, negative_prompt, models, steps, cfg_scale, width, height, loras, batch_count, seed, status, priority, auto_upload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    """, (
        item.prompt,
        item.negative_prompt,
        json.dumps(item.models),
        item.steps,
        item.cfg_scale,
        item.width,
        item.height,
        json.dumps([{"file": l.file, "weight": l.weight} for l in item.loras]),
        item.batch_count,
        item.seed,
        next_priority,
        1 if item.auto_upload else 0
    ))
    conn.commit()
    item_id = cursor.lastrowid
    conn.close()
    
    # Auto-start worker if it was idle
    if not worker.running:
        worker.start()
        
    return {"status": "success", "id": item_id}

@app.delete("/api/queue/{item_id}")
def delete_queue_item(item_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM queue WHERE id = ?", (item_id,))
    conn.commit()
    conn.close()
    
    # If the deleted item was currently active, background worker will notice it's gone and skip it.
    return {"status": "success"}

@app.put("/api/queue/{item_id}")
def update_queue_item(item_id: int, item: QueueItemCreate):
    conn = get_db()
    cursor = conn.cursor()
    
    # Check if item exists and status is pending
    cursor.execute("SELECT status FROM queue WHERE id = ?", (item_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Queue item not found")
        
    if row["status"] != "pending":
        conn.close()
        raise HTTPException(status_code=400, detail="Only pending queue items can be edited")
        
    cursor.execute("""
        UPDATE queue 
        SET prompt = ?, negative_prompt = ?, models = ?, steps = ?, cfg_scale = ?, width = ?, height = ?, loras = ?, batch_count = ?, seed = ?, auto_upload = ?
        WHERE id = ? AND status = 'pending'
    """, (
        item.prompt,
        item.negative_prompt,
        json.dumps(item.models),
        item.steps,
        item.cfg_scale,
        item.width,
        item.height,
        json.dumps([{"file": l.file, "weight": l.weight} for l in item.loras]),
        item.batch_count,
        item.seed,
        1 if item.auto_upload else 0,
        item_id
    ))
    conn.commit()
    conn.close()
    return {"status": "success"}

@app.post("/api/queue/reorder")
def reorder_queue(req: ReorderRequest):
    conn = get_db()
    cursor = conn.cursor()
    for item in req.items:
        cursor.execute("UPDATE queue SET priority = ? WHERE id = ?", (item.priority, item.id))
    conn.commit()
    conn.close()
    return {"status": "success"}

# Control operations
@app.get("/api/status")
def get_status():
    return {
        "running": worker.running,
        "current_task": worker.current_task,
        "error_message": worker.error_message
    }

@app.post("/api/control")
def post_control(ctrl: ControlAction):
    if ctrl.action == "start":
        worker.start()
        return {"status": "started"}
    elif ctrl.action == "pause":
        worker.pause()
        return {"status": "paused"}
    elif ctrl.action == "clear_completed":
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM queue WHERE status = 'completed' OR status = 'failed'")
        conn.commit()
        conn.close()
        return {"status": "cleared completed"}
    elif ctrl.action == "clear_all":
        # Pauses queue, clears everything
        worker.pause()
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM queue")
        conn.commit()
        conn.close()
        return {"status": "cleared all"}
    else:
        raise HTTPException(status_code=400, detail="Invalid action")

# Settings operations
@app.get("/api/settings")
def get_settings():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT key, value FROM settings")
    rows = cursor.fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}

@app.post("/api/settings")
def save_setting(settings: Dict[str, str]):
    conn = get_db()
    cursor = conn.cursor()
    for k, v in settings.items():
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (k, v))
    conn.commit()
    conn.close()
    return {"status": "success"}

# History / Gallery operations
@app.get("/api/history")
def get_history(limit: int = 50, offset: int = 0):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT * FROM history 
        ORDER BY created_at DESC 
        LIMIT ? OFFSET ?
    """, (limit, offset))
    rows = cursor.fetchall()
    conn.close()
    
    result = []
    for r in rows:
        result.append({
            "id": r["id"],
            "queue_id": r["queue_id"],
            "prompt": r["prompt"],
            "negative_prompt": r["negative_prompt"],
            "model": r["model"],
            "seed": r["seed"],
            "steps": r["steps"],
            "cfg_scale": r["cfg_scale"],
            "width": r["width"],
            "height": r["height"],
            "loras": json.loads(r["loras"]) if r["loras"] else [],
            "filename": r["filename"],
            "status": r["status"],
            "error_message": r["error_message"],
            "civitai_url": r["civitai_url"] if "civitai_url" in r.keys() else None,
            "created_at": r["created_at"]
        })
    return result

# Serve Frontend HTML, CSS, JS
@app.get("/")
def read_root():
    index_file = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return JSONResponse(content={"message": "Frontend static files not found in /static. Put index.html in the static/ folder."}, status_code=404)

# Mount static folder
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

if __name__ == "__main__":
    # Auto-scan & auto-start server on port 8000
    print("====================================================")
    print("      Draw Things Queue Manager Server Starting      ")
    print("====================================================")
    print(f"Backend directory: {BASE_DIR}")
    print(f"Outputs folder:    {OUTPUT_DIR}")
    print(f"SQLite DB:         {DB_PATH}")
    print("To open Web UI, visit: http://localhost:8000")
    print("====================================================")
    
    # Auto-start worker when starting server
    worker.start()
    
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
