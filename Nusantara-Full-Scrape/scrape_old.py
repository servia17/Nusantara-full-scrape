from playwright.sync_api import sync_playwright
from urllib.parse import urljoin, urlparse
import os
import json
import re
import time
import requests

START_URL = "https://nusantara-hub-8.preview.emergentagent.com/"
OUT = "output"

os.makedirs(OUT, exist_ok=True)
os.makedirs(f"{OUT}/pages", exist_ok=True)
os.makedirs(f"{OUT}/images", exist_ok=True)

visited = set()
queue = [START_URL]
all_images = set()

def safe_name(url):
    path = urlparse(url).path.strip("/")
    if not path:
        return "index"
    return re.sub(r"[^a-zA-Z0-9_-]", "_", path)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    while queue:
        url = queue.pop(0)

        if url in visited:
            continue

        print("PAGE:", url)

        try:
            page.goto(url, wait_until="networkidle", timeout=60000)

            # Scroll supaya lazy-loaded content muncul
            for _ in range(10):
                page.mouse.wheel(0, 2000)
                page.wait_for_timeout(500)

            html = page.content()

            filename = safe_name(url) + ".html"

            with open(
                f"{OUT}/pages/{filename}",
                "w",
                encoding="utf-8"
            ) as f:
                f.write(html)

            visited.add(url)

            # Semua link
            links = page.locator("a").evaluate_all(
                """els => els.map(e => e.href).filter(Boolean)"""
            )

            for link in links:
                if (
                    link.startswith(START_URL)
                    and link not in visited
                    and link not in queue
                ):
                    queue.append(link)

            # Semua gambar
            images = page.locator("img").evaluate_all(
                """els => els.map(e => e.src).filter(Boolean)"""
            )

            all_images.update(images)

        except Exception as e:
            print("ERROR:", url, e)

    browser.close()

# Simpan URL
with open(f"{OUT}/pages.json", "w") as f:
    json.dump(sorted(visited), f, indent=2)

with open(f"{OUT}/images.json", "w") as f:
    json.dump(sorted(all_images), f, indent=2)

# Download gambar
for i, url in enumerate(sorted(all_images), 1):
    try:
        ext = os.path.splitext(urlparse(url).path)[1]

        if not ext or len(ext) > 5:
            ext = ".jpg"

        filename = f"{OUT}/images/{i:04d}{ext}"

        r = requests.get(
            url,
            timeout=30,
            headers={"User-Agent": "Mozilla/5.0"}
        )

        if r.ok:
            with open(filename, "wb") as f:
                f.write(r.content)

            print("IMAGE:", filename)

    except Exception as e:
        print("IMAGE ERROR:", url, e)

print()
print("SELESAI")
print("Pages :", len(visited))
print("Images:", len(all_images))
print("Folder:", os.path.abspath(OUT))
