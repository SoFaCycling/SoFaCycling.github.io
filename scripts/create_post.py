import os
import requests
import json
import re
import math
from datetime import datetime
from staticmap import StaticMap, Line
from PIL import Image
from PIL.ExifTags import TAGS
from PIL import ImageOps


# ------------------------------
# configuration
# ------------------------------

# Strava
CLIENT_ID = os.getenv("STRAVA_CLIENT_ID")
CLIENT_SECRET = os.getenv("STRAVA_CLIENT_SECRET")
REFRESH_TOKEN = os.getenv("STRAVA_REFRESH_TOKEN")

# Directories
POST_DIR = "blog/posts"
TEMPLATE_FILE = "scripts/post_template.qmd"

# Working mode for activity pull
MODE = "static_id"
# options:
# "offline_id"
# "static_id"
# "latest_ride"

# Activity ID
# for MODE = "offline_id" or MODE = "static_id"
STATIC_ACTIVITY_ID = 15470501328

# Trip group 
TRIP_NAME = None
# options: 
# TRIP_NAME = "trip name"
# TRIP_NAME = None
# for activities outside a trip

# Further categories
CATEGORIES = ["Frankreich", "Granfondo"]
# options:
# CATEGORIES = ["category 1", "category 2"]
# CATEGORIES = None


# ------------------------------
# helper: safe folder name
# ------------------------------
def safe_slug(text):
    text = text.lower()

    replacements = {
        "ä": "ae",
        "ö": "oe",
        "ü": "ue",
        "ß": "ss"
    }
    for k, v in replacements.items():
        text = text.replace(k, v)

    text = re.sub(r'[^a-z0-9\s_-]', "", text)
    text = re.sub(r"\s+", "_", text)
    text = re.sub(r"_+", "_", text)

    return text.strip("_")


# ------------------------------
# helper: distance calculation
# ------------------------------
def haversine(p1, p2):
  
    R = 6371000
    lat1, lon1 = math.radians(p1[0]), math.radians(p1[1])
    lat2, lon2 = math.radians(p2[0]), math.radians(p2[1])

    dlat = lat2 - lat1
    dlon = lon2 - lon1

    a = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1-a))

    return R * c


# ------------------------------
# helper: blog thumbnail
# ------------------------------
def generate_thumbnail(latlng, post_path):
    if not latlng:
        return

    coords = [[lon, lat] for lat, lon in latlng]

    width = 100
    height = 100

    m = StaticMap(width, height)

    line = Line(coords, 'black', 1)
    m.add_line(line)

    thumb_path = os.path.join(post_path, "thumbnail.png")

    image = m.render()
    image.save(thumb_path)

    print(f"🖼  Map thumbnail created (Size: {width}x{height}px).")


# ------------------------------
# helper: read existing trip stats
# ------------------------------

def get_trip_totals(trip_name, current_date, current_strava_id):

    total_km = 0
    total_elev = 0
    total_time = 0

    seen_ids = set()

    if not os.path.exists(POST_DIR):
        return total_km, total_elev, total_time

    for folder in os.listdir(POST_DIR):

        qmd = os.path.join(POST_DIR, folder, "index.qmd")

        if not os.path.exists(qmd):
            continue

        with open(qmd, "r", encoding="utf-8") as f:
            text = f.read()

        if f"trip: {trip_name}" not in text:
            continue

        # Datum lesen
        date_match = re.search(r'date:\s*"?([0-9\-]+)', text)
        if not date_match:
            continue

        post_date = date_match.group(1)

        if post_date > current_date:
            continue

        # Strava ID lesen
        id_match = re.search(r"strava_id:\s*([0-9]+)", text)
        if not id_match:
            continue

        strava_id = id_match.group(1)

        # aktuelle Tour ignorieren
        if strava_id == str(current_strava_id):
            continue

        # doppelte verhindern
        if strava_id in seen_ids:
            continue

        seen_ids.add(strava_id)

        km = re.search(r"distance_km:\s*([0-9.]+)", text)
        hm = re.search(r"elevation_m:\s*([0-9.]+)", text)
        tm = re.search(r"moving_time_min:\s*([0-9.]+)", text)

        if km:
            total_km += float(km.group(1))

        if hm:
            total_elev += float(hm.group(1))

        if tm:
            total_time += float(tm.group(1))

    return total_km, total_elev, total_time


# ------------------------------
# helper: format time
# ------------------------------
def format_minutes(minutes):
  
    minutes = int(round(minutes))

    hours = minutes // 60
    mins = minutes % 60

    if hours == 0:
        return f"{mins}min"

    return f"{hours}h {mins}min"


# ------------------------------
# helper: extract exif date and caption
# ------------------------------
def get_exif_date(filepath):

    try:
        img = Image.open(filepath)
        exif_data = img._getexif()

        if exif_data:
            for tag, value in exif_data.items():
                tag_name = TAGS.get(tag, tag)

                if tag_name == "DateTimeOriginal":
                    return datetime.strptime(value, "%Y:%m:%d %H:%M:%S")
    except:
        pass

    timestamp = os.path.getmtime(filepath)
    return datetime.fromtimestamp(timestamp)


def clean_caption(text):
    text = text.replace("\x00", "")
    text = text.strip()
    return text


def get_exif_caption(filepath):

    try:
        img = Image.open(filepath)
        exif_data = img._getexif()

        if exif_data:
            for tag, value in exif_data.items():
                tag_name = TAGS.get(tag, tag)

                if tag_name in ["ImageDescription", "UserComment", "XPComment", "XPTitle"]:

                    if isinstance(value, bytes):
                        try:
                            text = value.decode("utf-16").strip("\x00").strip()
                        except:
                            text = value.decode("utf-8", errors="ignore").strip()
                        return clean_caption(text)

                    return clean_caption(str(value))
    except:
        pass
    return ""


# ------------------------------
# helper: rename images by time
# ------------------------------

def rename_images_by_date(images_dir):

    extensions = (".jpg", ".jpeg", ".png", ".heic")

    for file in os.listdir(images_dir):

        if not file.lower().endswith(extensions):
            continue

        old_path = os.path.join(images_dir, file)
        date_obj = get_exif_date(old_path)
        new_name = date_obj.strftime("%Y%m%d_%H%M%S")
        ext = os.path.splitext(file)[1].lower()
        new_file = f"{new_name}{ext}"
        new_path = os.path.join(images_dir, new_file)

        if old_path == new_path:
            continue
        counter = 1

        while os.path.exists(new_path):
            new_file = f"{new_name}_{counter:02d}{ext}"
            new_path = os.path.join(images_dir, new_file)
            counter += 1

        os.rename(old_path, new_path)
        print(f"📷 Renamed {file} → {new_file}")


# ------------------------------
# helper: convert images to webp
# ------------------------------

def convert_images_to_webp(images_dir):

    MAX_WIDTH = 1800
    QUALITY = 80

    caption_cache = {}

    for file in os.listdir(images_dir):

        if not file.lower().endswith((".jpg", ".jpeg", ".png", ".heic")):
            continue

        path = os.path.join(images_dir, file)

        # EXIF Caption VOR der Konvertierung holen
        caption_cache[file] = get_exif_caption(path)

        img = Image.open(path)
        img = ImageOps.exif_transpose(img)

        width, height = img.size
        if width > MAX_WIDTH:
            ratio = MAX_WIDTH / width
            new_size = (MAX_WIDTH, int(height * ratio))
            img = img.resize(new_size, Image.LANCZOS)

        name = os.path.splitext(file)[0]
        new_path = os.path.join(images_dir, f"{name}.webp")

        img.save(new_path, "WEBP", quality=QUALITY, method=6)
        img.close()

        os.remove(path)

        print(f"🖼  Converted {file} → {name}.webp")

    return caption_cache


# ------------------------------
# helper: create gallery if images exist
# ------------------------------

def create_gallery(images_dir, gallery_file):

    image_files = [
        f for f in os.listdir(images_dir)
        if f.lower().endswith(".webp")
    ]
    image_files.sort()

    if not image_files:
        return

    if os.path.exists(gallery_file):
        return

    with open(gallery_file, "w", encoding="utf-8") as f:
        f.write("::: {.gallery}\n\n")
        for img in image_files:
            f.write(f"![](img/{img}){{group=\"tour\"}}\n\n")
        f.write(":::\n")

    print("📷 gallery.qmd created")


# ------------------------------
# helper: synchronize gallery
# ------------------------------

def sync_gallery(images_dir, gallery_file):

    # aktuelle Bilder im Ordner
    current_images = {
        f for f in os.listdir(images_dir)
        if f.lower().endswith(".webp")
    }

    ordered_images = []
    captions = {}

    # bestehende gallery einlesen
    if os.path.exists(gallery_file):

        with open(gallery_file, "r", encoding="utf-8") as f:
            lines = f.readlines()

        for line in lines:

            match = re.search(r'!\[(.*?)\]\(img\/([^\)]+)\)', line)

            if match:

                caption = match.group(1)
                img = match.group(2)

                if img in current_images:
                    ordered_images.append(img)
                    captions[img] = caption

    # neue Bilder erkennen
    new_images = sorted(current_images - set(ordered_images))

    # neue Bilder chronologisch einsortieren
    for new_img in new_images:

        inserted = False

        for i, existing in enumerate(ordered_images):

            if new_img < existing:
                ordered_images.insert(i, new_img)
                inserted = True
                break

        if not inserted:
            ordered_images.append(new_img)

    # neue gallery schreiben
    lines = ["::: {.gallery}\n\n"]

    for img in ordered_images:

        caption = captions.get(img, "")

        # EXIF nur wenn noch keine Caption existiert
        if caption == "":
        
            original_name = img.replace(".webp", ".jpg")
        
            if original_name in caption_cache:
                caption = caption_cache[original_name]

        lines.append(
            f"![{caption}](img/{img}){{group=\"tour\"}}\n\n"
        )

    lines.append(":::\n")

    with open(gallery_file, "w", encoding="utf-8") as f:
        f.writelines(lines)

    print("📷 gallery.qmd synced with img folder.")


# ------------------------------
# get Strava token if needed
# ------------------------------
access_token = None
headers = None

def get_token():
    token_url = "https://www.strava.com/oauth/token"

    payload = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": REFRESH_TOKEN
    }

    r = requests.post(token_url, data=payload)
    r.raise_for_status()

    return r.json()["access_token"]


# ------------------------------
# load activity
# ------------------------------

activity = None
streams = None

if MODE == "offline_id":

    activity_file = "activity_snapshot.json"
    streams_file = "streams_snapshot.json"

    if os.path.exists(activity_file) and os.path.exists(streams_file):

        print("📦 Using local activity snapshot")

        with open(activity_file, "r", encoding="utf-8") as f:
            activity = json.load(f)

        with open(streams_file, "r", encoding="utf-8") as f:
            streams = json.load(f)

    else:

        print("⬇️ No snapshot found → downloading activity")

        access_token = get_token()
        headers = {"Authorization": f"Bearer {access_token}"}

        activity_url = f"https://www.strava.com/api/v3/activities/{STATIC_ACTIVITY_ID}"

        r = requests.get(activity_url, headers=headers)
        r.raise_for_status()

        activity = r.json()

        with open(activity_file, "w", encoding="utf-8") as f:
            json.dump(activity, f)

        streams_url = f"https://www.strava.com/api/v3/activities/{STATIC_ACTIVITY_ID}/streams"

        params = {"keys": "latlng,altitude", "key_by_type": "true"}

        r = requests.get(streams_url, headers=headers, params=params)
        streams = r.json()

        with open(streams_file, "w", encoding="utf-8") as f:
            json.dump(streams, f)

        print("💾 Snapshot saved for offline mode")


elif MODE == "static_id":

    access_token = get_token()
    headers = {"Authorization": f"Bearer {access_token}"}

    activity_url = f"https://www.strava.com/api/v3/activities/{STATIC_ACTIVITY_ID}"

    r = requests.get(activity_url, headers=headers)
    r.raise_for_status()

    activity = r.json()


elif MODE == "latest_ride":

    access_token = get_token()
    headers = {"Authorization": f"Bearer {access_token}"}

    r = requests.get(
        "https://www.strava.com/api/v3/athlete/activities",
        headers=headers,
        params={"per_page": 5}
    )

    r.raise_for_status()

    activities = r.json()

    for a in activities:

        if a["type"] == "Ride" and not a.get("trainer", False):
            activity = a
            break

    if activity is None:
        raise Exception("No outdoor ride found among last 5 activities")


# ------------------------------
# extract activity data
# ------------------------------

name = activity["name"]
start_date = activity["start_date_local"]

distance_km = round(activity["distance"] / 1000, 1)
moving_time_min = round(activity["moving_time"] / 60)
elevation_m = round(activity["total_elevation_gain"])

type_sport = activity["type"]

avg_speed = round(activity.get("average_speed", 0) * 3.6, 1)
max_speed = round(activity.get("max_speed", 0) * 3.6, 1)

avg_watts = activity.get("average_watts")
max_watts = activity.get("max_watts")

avg_hr = activity.get("average_heartrate")
max_hr = activity.get("max_heartrate")

calories = activity.get("calories")

achievement_count = activity.get("achievement_count")

date_str = datetime.strptime(start_date[:10], "%Y-%m-%d").strftime("%Y-%m-%d")

post_slug = f"{date_str}_{safe_slug(name)}"
post_path = os.path.join(POST_DIR, post_slug)



# ------------------------------
# build dashboard
# ------------------------------

dashboard_html = ""

if TRIP_NAME:

    trip_km, trip_elev, trip_time = get_trip_totals(
        TRIP_NAME,
        date_str,
        activity["id"]
    )

    trip_km += distance_km
    trip_elev += elevation_m
    trip_time += moving_time_min

    dashboard_html = f"""
::: {{.trip-dashboard}}

### {TRIP_NAME}: Stand aktuell

<div class="trip-grid">

<div class="trip-card">
<div class="trip-value">{trip_km:.0f}</div>
<div class="trip-label">Kilometer</div>
</div>

<div class="trip-card">
<div class="trip-value">{trip_elev:.0f}</div>
<div class="trip-label">Höhenmeter</div>
</div>

<div class="trip-card">
<div class="trip-value">{format_minutes(trip_time)}</div>
<div class="trip-label">Fahrzeit</div>
</div>

</div>

:::
"""


# ------------------------------
# create post folder structure
# ------------------------------

os.makedirs(post_path, exist_ok=True)

# --- img folder
images_dir = os.path.join(post_path, "img")
os.makedirs(images_dir, exist_ok=True)

# photo preprocessing pipeline
rename_images_by_date(images_dir)
caption_cache = convert_images_to_webp(images_dir)


# -- gallery
gallery_file = os.path.join(post_path, "gallery.qmd")
create_gallery(images_dir, gallery_file)

# synchronize gallery if necessary
sync_gallery(images_dir, gallery_file)


# -- story file
story_file = os.path.join(post_path, "story.md")

if not os.path.exists(story_file):
    with open(story_file, "w", encoding="utf-8") as f:
        f.write("")



# ------------------------------
# get streams if needed
# ------------------------------

if streams is None:

    activity_id = activity["id"]

    streams_url = f"https://www.strava.com/api/v3/activities/{activity_id}/streams"

    params = {"keys": "latlng,altitude", "key_by_type": "true"}

    r = requests.get(streams_url, headers=headers, params=params)

    streams = r.json() if r.status_code == 200 else {}

latlng = streams.get("latlng", {}).get("data", [])
altitude = streams.get("altitude", {}).get("data", [])


# ------------------------------
# build track.json
# ------------------------------

if latlng and altitude:

    distance = [0]

    for i in range(1, len(latlng)):
        d = haversine(latlng[i-1], latlng[i])
        distance.append(distance[-1] + d)

    distance = [round(d/1000, 3) for d in distance]

    data_file_post = os.path.join(post_path, "track.json")

    with open(data_file_post, "w", encoding="utf-8") as f:
        json.dump({
            "latlng": latlng,
            "altitude": altitude,
            "distance": distance
        }, f)

    print("🗺  Track saved.")
    
    generate_thumbnail(latlng, post_path)


# ------------------------------
# generate index.qmd
# ------------------------------

with open(TEMPLATE_FILE, "r", encoding="utf-8") as f:
    template = f.read()


# Tour meta data
trip_meta = f"""strava_id: {activity["id"]}
distance_km: {distance_km}
elevation_m: {elevation_m}
moving_time_min: {moving_time_min}"""

meta_lines = []

if TRIP_NAME:
    meta_lines.append(f"trip: {TRIP_NAME}")


if TRIP_NAME and CATEGORIES:
    cats = [TRIP_NAME] + CATEGORIES
elif TRIP_NAME:
    cats = [TRIP_NAME]
elif CATEGORIES:
    cats = CATEGORIES
else:
    cats = None

if cats:
    cats_str = ", ".join(cats)
    meta_lines.append(f"categories: [{cats_str}]")

meta_lines.append(trip_meta)

trip_meta = "\n".join(meta_lines)



# -- Photo block
photo_block = ""

if os.path.exists(gallery_file):

    with open(gallery_file, "r", encoding="utf-8") as f:
        photo_block = f.read()
    


    
# -- story block
with open(story_file, "r", encoding="utf-8") as f:
    text_block = f.read()


content = template.replace("{{NAME}}", name)\
.replace("{{DATE}}", date_str)\
.replace("{{TYPE}}", type_sport)\
.replace("{{DISTANCE}}", str(distance_km))\
.replace("{{TIME}}", format_minutes(moving_time_min))\
.replace("{{ELEVATION}}", str(elevation_m))\
.replace("{{AVG_SPEED}}", str(avg_speed))\
.replace("{{MAX_SPEED}}", str(max_speed))\
.replace("{{AVG_WATTS}}", str(avg_watts))\
.replace("{{MAX_WATTS}}", str(max_watts))\
.replace("{{AVG_HR}}", str(avg_hr))\
.replace("{{MAX_HR}}", str(max_hr))\
.replace("{{CALORIES}}", str(calories))\
.replace("{{ACHIEVEMENTS}}", str(achievement_count))\
.replace("{{PHOTO_BLOCK}}", photo_block)\
.replace("{{TEXT_BLOCK}}", text_block)\
.replace("{{DASHBOARD_TRIP_COUNT}}", dashboard_html)


content = content.replace(
    "draft: false",
    f"draft: false\n{trip_meta}"
)

description = f"{distance_km:.0f} km mit {elevation_m} Hm"
content = content.replace("{{DESCRIPTION}}", description)


qmd_file = os.path.join(post_path, "index.qmd")

with open(qmd_file, "w", encoding="utf-8") as f:
    f.write(content)

print(f"✅ New post created: {qmd_file}")
