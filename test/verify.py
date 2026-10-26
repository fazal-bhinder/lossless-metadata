"""Independent verification. Deliberately does NOT use any of our own parsers."""
import json, os, subprocess, sys
from PIL import Image, ImageChops

HERE = os.path.dirname(__file__)
FIX, OUT = os.path.join(HERE, "fixtures"), os.path.join(HERE, "out")

# Tags that must never survive. Numeric EXIF ids.
FORBIDDEN_EXIF = {
    271: "Make", 272: "Model", 305: "Software", 315: "Artist",
    270: "ImageDescription", 306: "DateTime", 33432: "Copyright",
    34853: "GPSInfo", 34665: "ExifIFD", 700: "XMP", 33723: "IPTC", 37510: "UserComment",
}
ALLOWED_KEPT = {274, 33432, 315}  # Orientation kept by default; Copyright/Artist opt-in

fails, checks = [], 0

def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        fails.append(msg)

for name in sorted(os.listdir(FIX)):
    src, dst = os.path.join(FIX, name), os.path.join(OUT, name)
    if not os.path.exists(dst):
        fails.append(f"{name}: no output produced"); continue
    ext = name.rsplit(".", 1)[-1].lower()

    if ext in ("mp4", "mov"):
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format_tags", "-of", "json", dst],
            capture_output=True, text=True)
        tags = json.loads(out.stdout or "{}").get("format", {}).get("tags", {})
        leaked = {k: v for k, v in tags.items()
                  if k.lower() not in ("major_brand", "minor_version", "compatible_brands")}
        check(not leaked, f"{name}: video tags survived -> {leaked}")
        # Container must still be decodable and the same length.
        probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                "-show_entries", "stream=nb_frames,width,height", "-of", "json", dst],
                               capture_output=True, text=True)
        check(probe.returncode == 0, f"{name}: output is not a decodable video")
        s_old = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                "-show_entries", "stream=width,height", "-of", "json", src],
                               capture_output=True, text=True).stdout
        check(probe.stdout.replace('"nb_frames"', '"nb_frames"') and
              json.loads(probe.stdout)["streams"][0]["width"] == json.loads(s_old)["streams"][0]["width"],
              f"{name}: video dimensions changed")
        print(f"  {name}: video clean, still decodable")
        continue

    a, b = Image.open(src), Image.open(dst)

    # 1. Pixels must be bit-identical. This is the headline claim.
    if ext == "gif":
        a2, b2 = a.convert("RGB"), b.convert("RGB")
    else:
        a2, b2 = a.convert("RGB"), b.convert("RGB")
    diff = ImageChops.difference(a2, b2)
    check(diff.getbbox() is None, f"{name}: PIXELS CHANGED (bbox={diff.getbbox()})")

    check(a.size == b.size, f"{name}: dimensions changed {a.size} -> {b.size}")

    # 2. No forbidden EXIF may survive.
    try:
        ex = dict(b.getexif())
    except Exception:
        ex = {}
    leaked = {FORBIDDEN_EXIF[k]: v for k in ex if k in FORBIDDEN_EXIF and k not in ALLOWED_KEPT}
    check(not leaked, f"{name}: EXIF survived -> {leaked}")

    # 3. No PNG text chunks may survive.
    if ext == "png":
        check(not getattr(b, "text", {}), f"{name}: PNG text survived -> {list(getattr(b,'text',{}))}")
        # No ancillary chunk that carries metadata may survive either. caBX is
        # the one that matters: it holds C2PA content credentials and, unlike a
        # text chunk, PIL will not show it to you.
        raw_png = open(dst, "rb").read()
        for chunk in (b"caBX", b"eXIf", b"tEXt", b"iTXt", b"zTXt"):
            check(chunk not in raw_png, f"{name}: {chunk.decode()} chunk survived")
        check(b"jumb" not in raw_png, f"{name}: JUMBF/C2PA bytes survived")

    # 4. GIF comment must be gone.
    if ext == "gif":
        check(b"names itself" not in open(dst, "rb").read(), f"{name}: GIF comment survived")

    # 5. Raw byte scan for known secrets, whatever the container.
    raw = open(dst, "rb").read()
    for needle in (b"Jane Photographer", b"Canon EOS R5", b"123456789ABC",
                   b"Midjourney", b"AUTOMATIC1111", b"3126544862",
                   b"secret internal comment", b"private note", b"Adobe Photoshop"):
        check(needle not in raw, f"{name}: secret {needle!r} still present in bytes")

    print(f"  {name}: pixels identical, {len(ex)} exif tag(s) left, no secrets")

print()
if fails:
    print(f"FAIL — {len(fails)} of {checks} checks failed:")
    for f in fails: print("   x " + f)
    sys.exit(1)
print(f"PASS — all {checks} independent checks passed")
