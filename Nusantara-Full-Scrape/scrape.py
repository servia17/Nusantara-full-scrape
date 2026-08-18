from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError
from urllib.parse import urlparse, unquote
import os
import re
import json
import hashlib
import mimetypes
import time

START_URL = "https://nusantara-hub-8.preview.emergentagent.com/"
BASE_HOST = urlparse(START_URL).netloc

OUT = "full_output"

PAGES_DIR = os.path.join(OUT, "pages")
NETWORK_DIR = os.path.join(OUT, "network")
API_DIR = os.path.join(OUT, "api")
IMAGES_DIR = os.path.join(OUT, "images")
SCRIPTS_DIR = os.path.join(OUT, "scripts")
STYLES_DIR = os.path.join(OUT, "styles")
FONTS_DIR = os.path.join(OUT, "fonts")
MEDIA_DIR = os.path.join(OUT, "media")
OTHER_DIR = os.path.join(OUT, "other")

for folder in [
    OUT,
    PAGES_DIR,
    NETWORK_DIR,
    API_DIR,
    IMAGES_DIR,
    SCRIPTS_DIR,
    STYLES_DIR,
    FONTS_DIR,
    MEDIA_DIR,
    OTHER_DIR,
]:
    os.makedirs(folder, exist_ok=True)


visited_pages = set()
queued_pages = {START_URL}
queue = [START_URL]

network_log = []
saved_urls = {}
failed_urls = []

# Hindari traffic yang tidak berguna untuk salinan website
SKIP_PATTERNS = [
    "/cdn-cgi/challenge-platform/",
    "google-analytics.com",
    "googletagmanager.com",
    "doubleclick.net",
    "posthog.com",
    "sentry.io",
]


def should_skip(url):
    return any(x in url for x in SKIP_PATTERNS)


def safe_filename(value):
    value = unquote(value)
    value = re.sub(r"[^\w.\-]+", "_", value)
    value = value.strip("._")
    return value[:180] or "index"


def page_filename(url):
    parsed = urlparse(url)
    path = parsed.path.strip("/")

    if not path:
        return "index.html"

    name = path.replace("/", "_")

    if parsed.query:
        qhash = hashlib.md5(
            parsed.query.encode()
        ).hexdigest()[:8]
        name += "_" + qhash

    return safe_filename(name) + ".html"


def extension_from_type(content_type):
    if not content_type:
        return ""

    content_type = content_type.split(";")[0].strip()

    mapping = {
        "application/json": ".json",
        "application/javascript": ".js",
        "text/javascript": ".js",
        "text/css": ".css",
        "text/html": ".html",
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/svg+xml": ".svg",
        "image/avif": ".avif",
        "font/woff": ".woff",
        "font/woff2": ".woff2",
        "application/font-woff": ".woff",
        "video/mp4": ".mp4",
        "video/webm": ".webm",
        "audio/mpeg": ".mp3",
    }

    if content_type in mapping:
        return mapping[content_type]

    ext = mimetypes.guess_extension(content_type)

    return ext or ""


def choose_folder(resource_type, content_type, url):
    ct = (content_type or "").lower()

    if (
        resource_type in ("xhr", "fetch")
        or "application/json" in ct
        or "/api/" in url
    ):
        return API_DIR

    if resource_type == "image" or ct.startswith("image/"):
        return IMAGES_DIR

    if resource_type == "script" or "javascript" in ct:
        return SCRIPTS_DIR

    if resource_type == "stylesheet" or "text/css" in ct:
        return STYLES_DIR

    if resource_type == "font" or "font/" in ct:
        return FONTS_DIR

    if (
        resource_type == "media"
        or ct.startswith("video/")
        or ct.startswith("audio/")
    ):
        return MEDIA_DIR

    return OTHER_DIR


def build_resource_name(url, content_type):
    parsed = urlparse(url)

    basename = os.path.basename(parsed.path)

    if basename:
        basename = safe_filename(basename)
    else:
        basename = "resource"

    existing_ext = os.path.splitext(basename)[1]

    if not existing_ext:
        ext = extension_from_type(content_type)
        basename += ext

    # Query string penting karena URL berbeda bisa punya filename sama
    if parsed.query:
        stem, ext = os.path.splitext(basename)

        qhash = hashlib.md5(
            parsed.query.encode()
        ).hexdigest()[:10]

        basename = f"{stem}_{qhash}{ext}"

    return basename


def save_network_response(response):
    url = response.url

    if should_skip(url):
        return

    request = response.request
    resource_type = request.resource_type

    try:
        headers = response.all_headers()
    except Exception:
        headers = response.headers

    content_type = headers.get("content-type", "")

    log_item = {
        "url": url,
        "status": response.status,
        "resource_type": resource_type,
        "content_type": content_type,
        "method": request.method,
    }

    network_log.append(log_item)

    # Jangan simpan error response sebagai resource
    if response.status < 200 or response.status >= 400:
        return

    # body() hanya setelah response selesai
    try:
        body = response.body()
    except Exception as e:
        failed_urls.append({
            "url": url,
            "error": str(e),
        })
        return

    if not body:
        return

    folder = choose_folder(
        resource_type,
        content_type,
        url,
    )

    filename = build_resource_name(
        url,
        content_type,
    )

    # Cegah overwrite jika dua domain punya nama sama
    host = safe_filename(urlparse(url).netloc)

    host_folder = os.path.join(folder, host)
    os.makedirs(host_folder, exist_ok=True)

    destination = os.path.join(
        host_folder,
        filename,
    )

    if destination in saved_urls.values():
        digest = hashlib.md5(
            url.encode()
        ).hexdigest()[:10]

        stem, ext = os.path.splitext(destination)
        destination = f"{stem}_{digest}{ext}"

    try:
        with open(destination, "wb") as f:
            f.write(body)

        saved_urls[url] = destination

        print(
            f"  SAVE [{resource_type:10}] "
            f"{response.status} {url}"
        )

    except Exception as e:
        failed_urls.append({
            "url": url,
            "error": str(e),
        })


def scroll_page(page):
    try:
        previous_height = 0

        for _ in range(15):
            height = page.evaluate(
                "document.body.scrollHeight"
            )

            if height == previous_height:
                break

            previous_height = height

            page.evaluate(
                "window.scrollTo(0, document.body.scrollHeight)"
            )

            page.wait_for_timeout(700)

    except Exception:
        pass


def discover_links(page):
    try:
        links = page.locator("a[href]").evaluate_all(
            """
            els => els.map(e => e.href).filter(Boolean)
            """
        )
    except Exception:
        return

    for link in links:
        try:
            parsed = urlparse(link)

            # hanya crawl halaman internal
            if parsed.netloc != BASE_HOST:
                continue

            if parsed.scheme not in ("http", "https"):
                continue

            clean = (
                parsed.scheme
                + "://"
                + parsed.netloc
                + parsed.path
            )

            if parsed.query:
                clean += "?" + parsed.query

            # buang fragment
            if clean not in visited_pages and clean not in queued_pages:
                queue.append(clean)
                queued_pages.add(clean)

        except Exception:
            pass


with sync_playwright() as p:

    browser = p.chromium.launch(
        headless=True
    )

    context = browser.new_context(
        ignore_https_errors=True,
        viewport={
            "width": 1440,
            "height": 1200,
        },
    )

    # BrowserContext menangkap request dari semua page/context
    context.on(
        "response",
        save_network_response,
    )

    page = context.new_page()

    while queue:
        url = queue.pop(0)

        if url in visited_pages:
            continue

        print("\n" + "=" * 80)
        print("PAGE:", url)
        print("=" * 80)

        try:
            page.goto(
                url,
                wait_until="domcontentloaded",
                timeout=60000,
            )

            # beri waktu SPA menjalankan API / JS
            page.wait_for_timeout(3000)

            try:
                page.wait_for_load_state(
                    "networkidle",
                    timeout=10000,
                )
            except PlaywrightTimeoutError:
                pass

            scroll_page(page)

            page.wait_for_timeout(1500)

            # simpan DOM setelah JS selesai
            html = page.content()

            html_file = os.path.join(
                PAGES_DIR,
                page_filename(url),
            )

            with open(
                html_file,
                "w",
                encoding="utf-8",
            ) as f:
                f.write(html)

            visited_pages.add(url)

            discover_links(page)

            print("HTML:", html_file)

        except Exception as e:
            print("PAGE ERROR:", e)

            failed_urls.append({
                "url": url,
                "error": str(e),
            })

    # Tunggu response terakhir selesai
    page.wait_for_timeout(3000)

    context.close()
    browser.close()


with open(
    os.path.join(OUT, "pages.json"),
    "w",
    encoding="utf-8",
) as f:
    json.dump(
        sorted(visited_pages),
        f,
        indent=2,
        ensure_ascii=False,
    )


with open(
    os.path.join(OUT, "network.json"),
    "w",
    encoding="utf-8",
) as f:
    json.dump(
        network_log,
        f,
        indent=2,
        ensure_ascii=False,
    )


with open(
    os.path.join(OUT, "saved_resources.json"),
    "w",
    encoding="utf-8",
) as f:
    json.dump(
        saved_urls,
        f,
        indent=2,
        ensure_ascii=False,
    )


with open(
    os.path.join(OUT, "failed.json"),
    "w",
    encoding="utf-8",
) as f:
    json.dump(
        failed_urls,
        f,
        indent=2,
        ensure_ascii=False,
    )


print("\n" + "=" * 80)
print("SELESAI")
print("=" * 80)
print("Pages        :", len(visited_pages))
print("Responses    :", len(network_log))
print("Saved files  :", len(saved_urls))
print("Failed       :", len(failed_urls))
print("Folder       :", os.path.abspath(OUT))
