# Study: which platforms strip photo metadata (2026)

These are the steps for one repeatable round trip per platform. Run them all on the same day. Record the date and app versions in `STUDY.md`. That date is what makes the study citable.

## Test images (`originals/`)

- `photo-gps.jpg`: JPEG with 22 EXIF tags, including GPS coordinates, camera make and model, and date taken.
- `c2pa-openai.png`: PNG carrying a real ChatGPT C2PA manifest (the "AI generated" label).

Upload these exact files. Don't use a real photo: the GPS in the test file points at San Francisco's Civic Center (37.7750, -122.4194), not at you.

## For each platform

1. Upload both files the normal way, as a post or a message.
2. Download them back the way an ordinary recipient would:
   - from a second account or browser
   - using the platform's own save or download option, never a screenshot
3. Save the downloads to `results/<platform>/`. Use names like `post.jpg` or `dm-photo.jpg`.
4. Where the platform has both a "photo" and a "file/document" mode, test both:
   - WhatsApp: photo vs document
   - Telegram: photo vs file
   - Discord: attachment, then "open original"
   - Slack, Signal
   - Name the downloads accordingly (`photo.jpg`, `document.jpg`).
5. Then run:

```
npx tsx study/check.ts > study/table.md
```

## Platforms

Instagram (post and DM), WhatsApp, Telegram, Discord, X, Facebook (post and Messenger), Reddit, LinkedIn, Pinterest, TikTok (photo post), Signal, Slack.

Some platforms convert PNG to JPEG. The script reports these as "converted" and checks whether anything survived. Expect the document/file modes to keep everything. That contrast is the most useful finding for readers.
