#!/usr/bin/env python3
# /// script
# dependencies = [
#   "requests",
#   "pillow",
#   "blurhash-python",
# ]
# ///

import os
import re
import sys
import json
import uuid
import datetime
import argparse
import requests
import glob
from urllib.parse import urljoin
from PIL import Image

CIVITAI_ROOT = "https://civitai.red"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": CIVITAI_ROOT,
    "Accept": "application/json",
}

def load_cookies_from_json(cookie_file):
    if not os.path.exists(cookie_file):
        raise FileNotFoundError(f"Cookie file not found: {cookie_file}")
    
    with open(cookie_file, 'r', encoding='utf-8') as f:
        content = f.read().strip()
        
    cookies = {}
    if content.startswith('{') or content.startswith('['):
        data = json.loads(content)
        if isinstance(data, list):
            # Browser exported cookies (EditThisCookie / Cookie-Editor format)
            for entry in data:
                if isinstance(entry, dict) and 'name' in entry and 'value' in entry:
                    cookies[entry['name']] = entry['value']
        elif isinstance(data, dict):
            if 'cookies' in data:
                # civitai_client format
                cookies = data['cookies']
            else:
                # Simple key-value format
                cookies = data
    else:
        # Treat as raw Semicolon-separated cookie string (e.g. copied from Network headers)
        for item in content.split(';'):
            item = item.strip()
            if '=' in item:
                k, v = item.split('=', 1)
                cookies[k.strip()] = v.strip()
    # Automatically map session tokens between .com and .red for ease of use
    if "__Secure-civitai-prod.session-token" in cookies and "__Secure-civitai-token" not in cookies:
        cookies["__Secure-civitai-token"] = cookies["__Secure-civitai-prod.session-token"]
    elif "__Secure-civitai-token" in cookies and "__Secure-civitai-prod.session-token" not in cookies:
        cookies["__Secure-civitai-prod.session-token"] = cookies["__Secure-civitai-token"]
        
    return cookies

def verify_session(session):
    print("Verifying session on Civitai.red...")
    resp = session.get(CIVITAI_ROOT)
    resp.raise_for_status()
    
    # Search for __NEXT_DATA__
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', resp.text)
    if not match:
        print("Warning: Could not find __NEXT_DATA__ in page source. Checking backup creator info endpoint...")
        try:
            r = session.post(
                f"{CIVITAI_ROOT}/api/trpc/user.getCreatorInfo",
                json={"json": {}}
            )
            if r.status_code == 200:
                print("Session seems valid (API responded successfully).")
                return True
        except:
            pass
        return False
        
    try:
        page_data = json.loads(match.group(1))
        session_data = page_data.get("props", {}).get("pageProps", {}).get("session", {})
        if session_data and "user" in session_data:
            user = session_data["user"]
            print(f"✅ Success! Logged in as: {user.get('username')} (ID: {user.get('id')}, Email: {user.get('email')})")
            return True
        else:
            print("❌ Error: No active session found. Please make sure your cookies are up to date.")
            return False
    except Exception as e:
        print(f"❌ Failed to parse session data: {e}")
        return False

def extract_metadata_from_png(local_file):
    try:
        img = Image.open(local_file)
        
        # Check standard info keys first
        params_str = img.info.get("parameters") or img.info.get("Description")
        meta = {}
        
        # If not found in standard keys, check in XMP (common for modern Draw Things versions)
        if not params_str:
            xmp_data = img.info.get("xmp") or img.info.get("XML:com.adobe.xmp")
            if xmp_data:
                if isinstance(xmp_data, bytes):
                    xmp_data = xmp_data.decode('utf-8', errors='ignore')
                
                # Try to extract from exif:UserComment which has JSON
                user_comment_match = re.search(r'<exif:UserComment>.*?<rdf:li[^>]*>(.*?)</rdf:li>.*?</exif:UserComment>', xmp_data, re.DOTALL)
                if user_comment_match:
                    json_str = user_comment_match.group(1).strip()
                    import html
                    json_str = html.unescape(json_str)
                    try:
                        dt_meta = json.loads(json_str)
                        if "c" in dt_meta:
                            meta["prompt"] = dt_meta["c"]
                        if "uc" in dt_meta:
                            meta["negativePrompt"] = dt_meta["uc"]
                        if "scale" in dt_meta:
                            meta["cfgScale"] = float(dt_meta["scale"])
                        if "steps" in dt_meta:
                            meta["steps"] = int(dt_meta["steps"])
                        if "sampler" in dt_meta:
                            meta["sampler"] = dt_meta["sampler"]
                        if "seed" in dt_meta:
                            meta["seed"] = int(dt_meta["seed"])
                        if "size" in dt_meta:
                            meta["Size"] = dt_meta["size"]
                        if "model" in dt_meta:
                            meta["Model"] = dt_meta["model"]
                        if "loras" in dt_meta:
                            meta["detected_loras"] = [l.get("file") or l.get("model") for l in dt_meta["loras"] if l.get("file") or l.get("model")]
                        elif "lora" in dt_meta:
                            meta["detected_loras"] = [l.get("file") or l.get("model") for l in dt_meta["lora"] if l.get("file") or l.get("model")]
                        return meta
                    except json.JSONDecodeError:
                        pass
                
                # Fallback: Try to extract from dc:description
                desc_match = re.search(r'<dc:description>.*?<rdf:li[^>]*>(.*?)</rdf:li>.*?</dc:description>', xmp_data, re.DOTALL)
                if desc_match:
                    desc_text = desc_match.group(1).strip()
                    import html
                    desc_text = html.unescape(desc_text)
                    params_str = desc_text

        if not params_str:
            return {}

        # If it is JSON (e.g. Draw Things JSON metadata format)
        if params_str.strip().startswith("{") and params_str.strip().endswith("}"):
            try:
                dt_meta = json.loads(params_str)
                if "prompt" in dt_meta:
                    meta["prompt"] = dt_meta["prompt"]
                if "negative_prompt" in dt_meta:
                    meta["negativePrompt"] = dt_meta["negative_prompt"]
                if "cfg_scale" in dt_meta:
                    meta["cfgScale"] = float(dt_meta["cfg_scale"])
                if "steps" in dt_meta:
                    meta["steps"] = int(dt_meta["steps"])
                if "sampler" in dt_meta:
                    meta["sampler"] = dt_meta["sampler"]
                if "seed" in dt_meta:
                    meta["seed"] = int(dt_meta["seed"])
                if "width" in dt_meta and "height" in dt_meta:
                    meta["Size"] = f"{dt_meta['width']}x{dt_meta['height']}"
                if "model" in dt_meta:
                    meta["Model"] = dt_meta["model"]
                if "loras" in dt_meta:
                    meta["detected_loras"] = [l.get("file") or l.get("model") for l in dt_meta["loras"] if l.get("file") or l.get("model")]
                return meta
            except json.JSONDecodeError:
                pass

        # Parse standard SD WebUI text block
        parts = params_str.split("\n")
        prompt_lines = []
        neg_prompt = ""
        params_line = ""
        
        for part in parts:
            if part.startswith("Negative prompt:"):
                neg_prompt = part[len("Negative prompt:"):].strip()
            elif "Steps:" in part and "Seed:" in part:
                params_line = part.strip()
            else:
                if not neg_prompt and not params_line:
                    prompt_lines.append(part)
                    
        meta['prompt'] = "\n".join(prompt_lines).strip()
        if neg_prompt:
            meta['negativePrompt'] = neg_prompt
            
        if params_line:
            param_dict = {}
            for item in params_line.split(","):
                if ":" in item:
                    k, v = item.split(":", 1)
                    param_dict[k.strip().lower()] = v.strip()
                    
            if 'steps' in param_dict:
                meta['steps'] = int(param_dict['steps'])
            if 'cfg scale' in param_dict:
                meta['cfgScale'] = float(param_dict['cfg scale'])
            if 'sampler' in param_dict:
                meta['sampler'] = param_dict['sampler']
            if 'seed' in param_dict:
                meta['seed'] = int(param_dict['seed'])
            if 'size' in param_dict:
                meta['Size'] = param_dict['size']
            if 'model' in param_dict:
                meta['Model'] = param_dict['model']
                
        return meta
    except Exception as e:
        print(f"Failed to parse image metadata: {e}")
        return {}

def get_blurhash(local_file):
    try:
        import blurhash
        import numpy as np
        img = Image.open(local_file).convert("RGB")
        img.thumbnail((32, 32))
        bhash = blurhash.encode(np.array(img), x_components=4, y_components=4)
        return bhash
    except Exception as e:
        # Return a valid fallback gray-rect blurhash if package is missing or fails
        return "L6PZ|aJ-0y~w.w_N_4ob_4-;_4W["

def upload_image(session, local_file):
    filename = os.path.basename(local_file)
    print(f"   Uploading S3 ticket for {filename}...")
    resp = session.post(
        f"{CIVITAI_ROOT}/api/v1/image-upload",
        json={
            "filename": filename,
            "metadata": {}
        }
    )
    resp.raise_for_status()
    ticket = resp.json()
    
    upload_id = ticket['id']
    upload_url = ticket['uploadURL']
    
    with open(local_file, 'rb') as f:
        # DO NOT use session cookies or custom headers for S3 PUT
        put_resp = requests.put(upload_url, data=f)
        put_resp.raise_for_status()
        
    return upload_id

def create_post(session, model_version_id=None):
    payload = {
        "json": {
            "modelVersionId": model_version_id,
            "authed": True
        }
    }
    resp = session.post(
        f"{CIVITAI_ROOT}/api/trpc/post.create",
        json=payload
    )
    resp.raise_for_status()
    res = resp.json()
    if 'error' in res:
        raise Exception(f"Failed to create post draft: {res['error']}")
    post_id = res['result']['data']['json']['id']
    print(f"   Created draft post container (ID: {post_id})")
    return post_id

def add_image_to_post(session, post_id, upload_image_id, local_file, index=0, model_version_id=None, normalized_mapping=None):
    filename = os.path.basename(local_file)
    img = Image.open(local_file)
    width, height = img.size
    
    bhash = get_blurhash(local_file)
    meta = extract_metadata_from_png(local_file)
    
    # 1. Build resources list
    resources = []
    
    # Add base model resource
    base_model_name = meta.get('Model')
    if base_model_name:
        resources.append({
            "type": "model",
            "name": base_model_name,
            "modelVersionId": model_version_id
        })
        
    # Detect LoRAs
    detected_loras = meta.get("detected_loras", [])[:]
            
    # From prompt text tags <lora:name:weight>
    prompt = meta.get('prompt', '')
    lora_matches = re.findall(r'<lora:([^:]+):([^>]+)>', prompt)
    for match in lora_matches:
        detected_loras.append(match[0])
        
    # Deduplicate LoRAs preserving order
    seen_loras = set()
    unique_loras = []
    for lora in detected_loras:
        if lora not in seen_loras:
            seen_loras.add(lora)
            unique_loras.append(lora)
            
    # Link other LoRAs (excluding private Mercury ZI LoRAs)
    for lora_name in unique_loras:
        name_lower = lora_name.lower()
        # Filter out local Mercury ZI LoRAs (case insensitive check for 'mercury' or 'zi')
        if "mercury" in name_lower or "zi" in name_lower:
            print(f"   [INFO] Skipping private/local LoRA: {lora_name}")
            continue
            
        lora_version_id = None
        if normalized_mapping:
            norm_key = normalize_model_key(lora_name)
            if norm_key in normalized_mapping:
                lora_version_id = normalized_mapping[norm_key]
                
        resources.append({
            "type": "lora",
            "name": lora_name,
            "modelVersionId": lora_version_id
        })
        if lora_version_id:
            print(f"   [INFO] Linked LoRA: {lora_name} -> Civitai Version: {lora_version_id}")
        else:
            print(f"   [INFO] Detected LoRA (no mapping found): {lora_name}")
            
    if resources:
        meta["resources"] = resources
    
    payload = {
        "json": {
            "type": "image",
            "index": index,
            "uuid": str(uuid.uuid4()),
            "name": filename,
            "meta": meta,
            "url": upload_image_id,
            "mimeType": "image/png" if local_file.lower().endswith('.png') else "image/jpeg",
            "hash": bhash,
            "width": width,
            "height": height,
            "status": "uploading",
            "postId": post_id,
            "modelVersionId": model_version_id,
            "authed": True
        }
    }
    resp = session.post(
        f"{CIVITAI_ROOT}/api/trpc/post.addImage",
        json=payload
    )
    resp.raise_for_status()
    res = resp.json()
    if 'error' in res:
        raise Exception(f"Failed to associate image to post draft: {res['error']}")

def add_tag_to_post(session, post_id, tag_name):
    payload = {
        "json": {
            "id": post_id,
            "name": tag_name,
            "authed": True
        }
    }
    resp = session.post(
        f"{CIVITAI_ROOT}/api/trpc/post.addTag",
        json=payload
    )
    resp.raise_for_status()
    res = resp.json()
    if 'error' in res:
        print(f"   [WARNING] Failed to add tag '{tag_name}': {res['error']['message']}")

def publish_post(session, post_id, title=None, detail=None, nsfw=False):
    payload = {
        "json": {
            "id": post_id,
            "title": title,
            "detail": detail,
            "nsfw": nsfw,
            "publishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()
        },
        "meta": {
            "values": {
                "publishedAt": ["Date"]
            }
        }
    }
    resp = session.post(
        f"{CIVITAI_ROOT}/api/trpc/post.update",
        json=payload
    )
    resp.raise_for_status()
    res = resp.json()
    if 'error' in res:
        raise Exception(f"Failed to publish post: {res['error']}")
    
    post_url = f"{CIVITAI_ROOT}/posts/{post_id}"
    print(f"   ✅ Published! Link: {post_url}")
    return post_url

def load_model_mapping(mapping_arg):
    if not mapping_arg:
        return {}
    
    # Try parsing as JSON string
    try:
        return json.loads(mapping_arg)
    except json.JSONDecodeError:
        pass
        
    # Try parsing as JSON file path
    if os.path.exists(mapping_arg):
        try:
            with open(mapping_arg, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Warning: Failed to load model mapping file: {e}")
            
    return {}

def normalize_model_key(key):
    if not key:
        return ""
    key = os.path.basename(key)
    for ext in ['.ckpt', '.safetensors', '.pt', '.png']:
        if key.lower().endswith(ext):
            key = key[:-len(ext)]
    return key.lower().strip()

def main():
    parser = argparse.ArgumentParser(description="Upload showcase images directly to Civitai.red")
    parser.add_argument("--image", nargs="+", required=True, help="One or more paths to local image files or wildcards")
    parser.add_argument("--cookies", default="cookies.json", help="Path to cookies.json file (default: cookies.json)")
    parser.add_argument("--tags", nargs="*", default=[], help="Optional list of tags for the post")
    parser.add_argument("--title", help="Optional title/title prefix for the post")
    parser.add_argument("--description", help="Optional description/detail markdown for the post")
    parser.add_argument("--nsfw", action="store_true", help="Flag the post as mature/NSFW")
    parser.add_argument("--model-version", nargs="*", type=int, help="Optional model version IDs to link the images to (ordered matching --image)")
    parser.add_argument("--model-mapping", help="Path to JSON file mapping model filenames/hashes to Civitai version IDs, or raw JSON string")
    parser.add_argument("--group-by-prompt", action="store_true", help="Automatically group images by their prompts and create one post per group")
    
    args = parser.parse_args()
    
    # Expand wildcards manually
    image_paths = []
    for pattern in args.image:
        matches = glob.glob(pattern)
        if matches:
            image_paths.extend(matches)
        else:
            image_paths.append(pattern)
            
    # Filter valid files
    valid_image_paths = []
    for p in image_paths:
        if os.path.exists(p):
            valid_image_paths.append(p)
        else:
            print(f"Warning: Image file not found: {p}")
            
    if not valid_image_paths:
        print("Error: No valid images found to upload.")
        sys.exit(1)
        
    # Load model mapping
    model_mapping = load_model_mapping(args.model_mapping)
    normalized_mapping = {normalize_model_key(k): v for k, v in model_mapping.items()}
    
    try:
        cookies = load_cookies_from_json(args.cookies)
    except FileNotFoundError:
        print(f"Error: Cookies file not found: {args.cookies}")
        print("Please export your civitai.red cookies using a browser extension and save as cookies.json.")
        sys.exit(1)
    except Exception as e:
        print(f"Error loading cookies: {e}")
        sys.exit(1)
        
    session = requests.Session()
    session.headers.update(HEADERS)
    session.cookies.update(cookies)
    
    if not verify_session(session):
        print("Error: Could not verify session. Your cookies may have expired.")
        sys.exit(1)
        
    def resolve_model_version_id(img_path, idx, meta):
        # 1. Order match CLI argument list
        if args.model_version:
            if idx < len(args.model_version):
                return args.model_version[idx]
            else:
                return args.model_version[0]
                
        # 2. Check model mapping
        model_name = meta.get('Model')
        if model_name:
            norm_key = normalize_model_key(model_name)
            if norm_key in normalized_mapping:
                return normalized_mapping[norm_key]
                
        return None
        
    try:
        if args.group_by_prompt:
            # 1. Group images by prompt only (even if base models are different)
            prompt_groups = {}
            for idx, img_path in enumerate(valid_image_paths):
                meta = extract_metadata_from_png(img_path)
                prompt = meta.get('prompt', '').strip()
                # Normalize prompt for grouping (collapse whitespace, lowercase)
                normalized_prompt = re.sub(r'\s+', ' ', prompt.lower()).strip()
                if not normalized_prompt:
                    normalized_prompt = "__no_prompt__"
                    
                if normalized_prompt not in prompt_groups:
                    prompt_groups[normalized_prompt] = {
                        "prompt": prompt,
                        "images": []
                    }
                prompt_groups[normalized_prompt]["images"].append((img_path, idx, meta))
                
            print(f"\n📂 Found {len(prompt_groups)} distinct prompt groups across {len(valid_image_paths)} images.")
            
            for p_key, group in prompt_groups.items():
                prompt_text = group["prompt"]
                grp_images = group["images"]
                
                display_prompt = prompt_text[:50] + "..." if len(prompt_text) > 50 else (prompt_text or "[No Prompt]")
                print(f"\n📁 Processing group: '{display_prompt}' ({len(grp_images)} images)")
                
                # Use first image model version for the post draft container
                first_img_path, first_idx, first_meta = grp_images[0]
                first_model_version = resolve_model_version_id(first_img_path, first_idx, first_meta)
                
                post_id = create_post(session, first_model_version)
                
                # Upload and add all images in this prompt group
                for index, (img_path, original_idx, meta) in enumerate(grp_images):
                    model_version = resolve_model_version_id(img_path, original_idx, meta)
                    model_name = meta.get('Model', 'Unknown Model')
                    print(f"   [{index+1}/{len(grp_images)}] Uploading {os.path.basename(img_path)} (Model: {model_name} -> Version: {model_version})")
                    
                    upload_id = upload_image(session, img_path)
                    add_image_to_post(
                        session=session, 
                        post_id=post_id, 
                        upload_image_id=upload_id, 
                        local_file=img_path, 
                        index=index, 
                        model_version_id=model_version,
                        normalized_mapping=normalized_mapping
                    )
                    
                # Add tags
                for tag in args.tags:
                    add_tag_to_post(session, post_id, tag)
                    
                # Publish post
                title = args.title or (prompt_text[:100] if prompt_text else "Showcase Image Group")
                publish_post(session, post_id, title=title, detail=args.description, nsfw=args.nsfw)
                
        else:
            # 2. Upload all images into a single post container
            print(f"\n📁 Uploading all {len(valid_image_paths)} images into a single Civitai post.")
            
            # Use first image model version for the post draft container
            first_meta = extract_metadata_from_png(valid_image_paths[0])
            first_model_version = resolve_model_version_id(valid_image_paths[0], 0, first_meta)
            
            post_id = create_post(session, first_model_version)
            
            for index, img_path in enumerate(valid_image_paths):
                meta = extract_metadata_from_png(img_path) if index > 0 else first_meta
                model_version = resolve_model_version_id(img_path, index, meta)
                model_name = meta.get('Model', 'Unknown Model')
                print(f"   [{index+1}/{len(valid_image_paths)}] Uploading {os.path.basename(img_path)} (Model: {model_name} -> Version: {model_version})")
                
                upload_id = upload_image(session, img_path)
                add_image_to_post(
                    session=session, 
                    post_id=post_id, 
                    upload_image_id=upload_id, 
                    local_file=img_path, 
                    index=index, 
                    model_version_id=model_version,
                    normalized_mapping=normalized_mapping
                )
                
            # Add tags
            for tag in args.tags:
                add_tag_to_post(session, post_id, tag)
                
            # Publish post
            publish_post(session, post_id, title=args.title, detail=args.description, nsfw=args.nsfw)
            
    except Exception as e:
        print(f"\n❌ Error during upload process: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
