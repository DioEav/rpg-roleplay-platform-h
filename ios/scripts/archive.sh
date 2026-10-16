#!/usr/bin/env bash
# 一键 archive + 导出 App Store ipa。先填 TEAM_ID(你的 Apple 开发者 TeamID)。
set -euo pipefail
cd "$(dirname "$0")/.."

TEAM_ID="${TEAM_ID:-CHANGEME_TEAMID}"
SCHEME="Meadhall"
ARCHIVE="build/Meadhall.xcarchive"
EXPORT_DIR="build/export"

if [ "$TEAM_ID" = "CHANGEME_TEAMID" ]; then
  echo "请先设置 TEAM_ID:  TEAM_ID=ABCDE12345 ./scripts/archive.sh" ; exit 1
fi

command -v xcodegen >/dev/null && xcodegen generate

xcodebuild -project Meadhall.xcodeproj -scheme "$SCHEME" \
  -sdk iphoneos -configuration Release \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  archive

cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>destination</key><string>export</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist build/ExportOptions.plist \
  -exportPath "$EXPORT_DIR"

echo "✅ 导出完成:$EXPORT_DIR  (用 Xcode Organizer 或 Transporter 上传到 App Store Connect)"
