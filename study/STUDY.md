# Platform metadata study: results log

Protocol: `study/README.md`. Table: `study/table.md` (regenerate with `npx tsx study/check.ts > study/table.md`).

## Runs

| Date | Platform | How | Notes |
|---|---|---|---|
| 2026-11-03 | Discord (web, Brave) | Both originals posted as attachments in a private, owner-only server ("metadata-test (private)"). Downloaded the cdn.discordapp.com attachment URL ("Open original") and the media.discordapp.net inline preview | The original attachment is re-written: JPEG 22 of 22 EXIF tags removed (GPS, camera, date), and the PNG's C2PA manifest removed. Inline previews are converted to WebP with no EXIF/C2PA |

| 2026-11-03 | Telegram Web (A) | Saved Messages. Photo mode (default compressed) and "Send all as files". Downloaded with the message menu → Download | **Photo mode** re-encodes (92.9 KB → 61 KB, PNG → 1 KB JPEG): GPS, camera, date and C2PA all removed. **File mode** returns both files **byte-identical**, so GPS and C2PA survive |
| 2026-11-03 | WhatsApp Web | "Message yourself" chat. Photos & videos vs Document. Downloaded with the message menu → Download | **Photo mode** removes everything (the PNG becomes a JPEG with no C2PA). **Document mode** returns both files **byte-identical**: GPS, camera, date and C2PA all survive |
| 2026-11-03 | Slack (web, free workspace) | DM to self, uploaded as files, "Download all" | The JPEG is re-written (92.9 KB → 74 KB) with all 22 EXIF tags removed. The PNG is also re-encoded (22 KB → 209 bytes, still 64×64) and its C2PA manifest is removed |

Headline so far: on Telegram and WhatsApp the "send as file/document" option keeps your GPS location and AI labels intact, while normal photo sends strip them. Discord and Slack strip even file attachments.

Note: in the `photo-mode-c2pa.jpg` rows, check.ts compares a PNG→JPEG conversion against the JPEG original, so its "n/a"/"14 of 22" cells are an artefact of the script. That file has no C2PA.

Still to run: Signal, and the public platforms (Instagram, X, Facebook, Reddit, LinkedIn, Pinterest, TikTok).
