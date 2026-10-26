"""Generate test files that actually carry the metadata we claim to remove."""
import io, os, struct, subprocess, zlib
from PIL import Image, PngImagePlugin
import piexif  # optional

OUT = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(OUT, exist_ok=True)

def base_image(w=640, h=480):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = ((x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256)
    return img

img = base_image()

# ── JPEG with full EXIF + GPS ──────────────────────────────────────────────
exif = {
    "0th": {
        piexif.ImageIFD.Make: b"Canon",
        piexif.ImageIFD.Model: b"Canon EOS R5",
        piexif.ImageIFD.Software: b"Adobe Photoshop 25.0",
        piexif.ImageIFD.Artist: b"Jane Photographer",
        piexif.ImageIFD.Copyright: b"(c) 2026 Jane Photographer",
        piexif.ImageIFD.DateTime: b"2026:03:14 09:26:53",
        piexif.ImageIFD.Orientation: 6,
    },
    "Exif": {
        piexif.ExifIFD.BodySerialNumber: b"123456789ABC",
        piexif.ExifIFD.LensModel: b"RF 24-70mm F2.8 L IS USM",
        piexif.ExifIFD.DateTimeOriginal: b"2026:03:14 09:26:53",
        piexif.ExifIFD.FNumber: (28, 10),
        piexif.ExifIFD.ISOSpeedRatings: 400,
        piexif.ExifIFD.UserComment: b"ASCII\x00\x00\x00private note",
    },
    "GPS": {
        piexif.GPSIFD.GPSLatitudeRef: b"N",
        piexif.GPSIFD.GPSLatitude: ((37, 1), (46, 1), (2994, 100)),
        piexif.GPSIFD.GPSLongitudeRef: b"W",
        piexif.GPSIFD.GPSLongitude: ((122, 1), (25, 1), (984, 100)),
        piexif.GPSIFD.GPSAltitude: (52, 1),
    },
    "1st": {}, "thumbnail": None,
}
img.save(f"{OUT}/photo-gps.jpg", quality=92, exif=piexif.dump(exif))

# JPEG with an XMP packet + a COM comment appended by hand
with open(f"{OUT}/photo-gps.jpg", "rb") as f:
    jpg = f.read()
xmp = (b'http://ns.adobe.com/xap/1.0/\x00<?xpacket begin="?"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
       b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
       b'<rdf:Description xmp:CreatorTool="Midjourney v6" dc:creator="Jane"/>'
       b'</rdf:RDF></x:xmpmeta><?xpacket end="w"?>')
seg = b"\xff\xe1" + struct.pack(">H", len(xmp) + 2) + xmp
com = b"\xff\xfe" + struct.pack(">H", 2 + 22) + b"secret internal comment"[:22]
with open(f"{OUT}/photo-xmp.jpg", "wb") as f:
    f.write(jpg[:2] + seg + com + jpg[2:])

# ── PNG with Stable Diffusion parameters + eXIf ────────────────────────────
meta = PngImagePlugin.PngInfo()
meta.add_text("parameters",
    "a cat astronaut, highly detailed\nNegative prompt: blurry\n"
    "Steps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 3126544862, "
    "Size: 640x480, Model hash: 6ce0161689, Model: v1-5-pruned-emaonly")
meta.add_text("Software", "AUTOMATIC1111 stable-diffusion-webui")
meta.add_itxt("Description", "vacation photo at home")
img.save(f"{OUT}/ai-image.png", pnginfo=meta)

img.save(f"{OUT}/plain.png")

# ── PNG carrying ONLY C2PA content credentials ─────────────────────────────
# The regression case: ChatGPT and Gemini exports carry no EXIF and no text
# chunks, just a `caBX` chunk holding a signed C2PA manifest. That produces
# zero *named* tags, so any code that measures "is there metadata?" by tag
# count concludes the file is clean when it is not.
#
# The manifests are real, lifted verbatim from an OpenAI and a Google export
# (test/c2pa/*.bin). Only the pixels they were signed over are substituted, to
# keep the fixture small. That breaks the manifest's internal hash — which is
# fine and deliberate: this tool detects and removes content credentials, it
# never validates the signature, so nothing under test reads that hash.
C2PA = os.path.join(os.path.dirname(__file__), "c2pa")

def png_chunk(typ: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + typ + data + struct.pack(">I", zlib.crc32(typ + data))

def with_cabx(manifest_name: str, out_name: str):
    """Rebuild a small PNG with a caBX chunk spliced in after IHDR."""
    with open(os.path.join(C2PA, manifest_name), "rb") as f:
        manifest = f.read()
    buf = io.BytesIO()
    base_image(64, 64).save(buf, format="PNG")
    png = buf.getvalue()

    # Walk to the end of IHDR; C2PA requires caBX before the pixel data.
    off, out = 8, bytearray(png[:8])
    while off < len(png):
        ln = struct.unpack(">I", png[off:off + 4])[0]
        typ = png[off + 4:off + 8]
        out += png[off:off + 12 + ln]
        if typ == b"IHDR":
            out += png_chunk(b"caBX", manifest)
        off += 12 + ln
    with open(f"{OUT}/{out_name}", "wb") as f:
        f.write(bytes(out))

with_cabx("openai.cabx.bin", "c2pa-openai.png")
with_cabx("google.cabx.bin", "c2pa-google.png")

# ── WebP / GIF / TIFF ──────────────────────────────────────────────────────
img.save(f"{OUT}/photo.webp", exif=piexif.dump(exif), quality=90)
img.save(f"{OUT}/photo.tiff", tiffinfo={270: "an image description", 305: "PIL leaks software tags"})
frames = [base_image(200, 150), base_image(200, 150).rotate(2)]
frames[0].save(f"{OUT}/anim.gif", save_all=True, append_images=frames[1:],
               duration=120, loop=0, comment=b"created by a tool that names itself")

print("images done")
