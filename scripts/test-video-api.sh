#!/bin/bash
# End-to-end API test for the video assembly endpoint.
# Assumes the dev server is already running on localhost:3000.
set -u

IMG_JOB_DIR=$(ls -td /tmp/autotube-images/test-* 2>/dev/null | head -1)
if [ -z "$IMG_JOB_DIR" ]; then
  echo "No test image dir found. Run the standalone test first."
  exit 1
fi
IMG_JOB_ID=$(basename "$IMG_JOB_DIR")
echo "imageJobId: $IMG_JOB_ID"

AUDIO_FILE=$(ls -t /tmp/autotube-test-audio/*.mp3 2>/dev/null | head -1)
if [ -z "$AUDIO_FILE" ]; then
  echo "No test audio found."
  exit 1
fi
echo "audio file: $AUDIO_FILE"

# Build the POST body in a temp file (base64 is too long for argv)
AUDIO_B64=$(base64 -w0 "$AUDIO_FILE")
BODY_FILE=$(mktemp)
python3 -c "
import json, sys
with open('$BODY_FILE', 'w') as f:
    json.dump({
        'imageJobId': '$IMG_JOB_ID',
        'imageCount': 4,
        'audioBase64': open('$AUDIO_FILE','rb').read().decode('base64') if False else __import__('base64').b64encode(open('$AUDIO_FILE','rb').read()).decode(),
        'audioDuration': 18,
        'mimeType': 'audio/mpeg'
    }, f)
"
echo "body file size: $(wc -c < $BODY_FILE) bytes"

echo ""
echo "=== POST /api/video ==="
POST_RESP=$(curl -s --max-time 30 -X POST http://localhost:3000/api/video \
  -H "Content-Type: application/json" \
  --data-binary "@$BODY_FILE")
echo "POST response: $POST_RESP"
JOB_ID=$(echo "$POST_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('jobId',''))" 2>/dev/null)
echo "video jobId: '$JOB_ID'"

if [ -z "$JOB_ID" ]; then
  echo "FAIL: no jobId returned"
  rm -f "$BODY_FILE"
  exit 1
fi

echo ""
echo "=== Poll until done (max 90s) ==="
for i in $(seq 1 60); do
  sleep 1.5
  STATUS_RESP=$(curl -s --max-time 8 "http://localhost:3000/api/video?jobId=$JOB_ID")
  STAGE=$(echo "$STATUS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stage',''))" 2>/dev/null)
  PROGRESS=$(echo "$STATUS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('progress',0))" 2>/dev/null)
  STATUS=$(echo "$STATUS_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  echo "  poll $i: status=$STATUS stage=$STAGE progress=$PROGRESS%"
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ]; then
    echo ""
    echo "FINAL RESPONSE:"
    echo "$STATUS_RESP" | python3 -m json.tool 2>/dev/null || echo "$STATUS_RESP"
    break
  fi
done

echo ""
echo "=== Verify download endpoint (full file) ==="
curl -s --max-time 15 -o /tmp/test-download.mp4 \
  -w "HTTP %{http_code} | size: %{size_download} bytes | type: %{content_type}\n" \
  "http://localhost:3000/api/video/download?jobId=$JOB_ID"
echo "Downloaded file:"
ls -la /tmp/test-download.mp4
echo "ffprobe of downloaded file:"
ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,r_frame_rate \
  -of default=noprint_wrappers=1 /tmp/test-download.mp4 2>&1

echo ""
echo "=== Range request test (video player seek) ==="
curl -s --max-time 8 -o /tmp/test-range.bin \
  -w "HTTP %{http_code} | range bytes: %{size_download} | content-range header below\n" \
  -D /tmp/test-headers.txt \
  -H "Range: bytes=0-1023" \
  "http://localhost:3000/api/video/download?jobId=$JOB_ID"
echo "Response headers:"
grep -i "content-range\|accept-ranges\|content-length" /tmp/test-headers.txt 2>/dev/null

rm -f "$BODY_FILE"
echo ""
echo "=== TEST COMPLETE ==="
