#!/bin/bash

# Give the desktop environment a moment to fully load
sleep 30

# hide mouse pointer
unclutter-xfixes --timeout 1 --jitter 5 --ignore-scrolling &

# Prevent console/DRM blanking
setterm -blank 0 -powerdown 0 2>/dev/null

# Existing xset calls (covers XWayland apps)
xset s off
xset -dpms
xset s noblank

# Clear any previous crash flags so Chromium doesn't show "restore pages" popup
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' ~/.config/chromium/Default/Preferences 2>/dev/null
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' ~/.config/chromium/Default/Preferences 2>/dev/null

chromium \
  --noerrdialogs \
  --disable-infobars \
  --kiosk "http://url/here" \
  --incognito \
  --no-first-run \
  --disable-translate \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --password-store=basic \
  --disable-pinch