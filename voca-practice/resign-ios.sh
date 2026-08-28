#!/bin/bash
#
# Weekly re-sign + reinstall for the free-provisioning build.
#
# A free Apple ID signs apps with a 7-day certificate, so the app stops launching
# a week after each install. This rebuilds and pushes it to the connected iPhone
# without opening Xcode.
#
# One-time setup must happen in Xcode first (see README-ios.md) — this script
# only repeats an install that Xcode has already been configured to sign.
#
# Usage:
#   ./resign-ios.sh              # auto-detect the connected iPhone
#   ./resign-ios.sh <device-id>  # target a specific device

set -euo pipefail

cd "$(dirname "$0")"

BUNDLE_ID="com.dykim.vocatrainer"
# Deliberately outside the project: ~/Documents is an iCloud Drive sync root (Desktop &
# Documents 동기화), and the file provider stamps com.apple.FinderInfo onto the .storyboardc
# directories ibtool generates. codesign refuses to sign anything carrying it —
# "resource fork, Finder information, or similar detritus not allowed" — so a build tree
# inside the project fails at the very last step, after everything else has succeeded.
# ~/Library is never synced.
DERIVED="$HOME/Library/Developer/VocaTrainer/build"
APP_PATH="$DERIVED/Build/Products/Debug-iphoneos/App.app"

echo "==> 웹 자산을 iOS 프로젝트로 복사"
npx cap copy ios

if [ $# -ge 1 ]; then
    DEVICE_ID="$1"
else
    echo "==> 연결된 기기 검색"
    # Columns are: Name Hostname Identifier State Model. Match State exactly —
    # a substring match would also hit "disconnected".
    DEVICE_ID=$(xcrun devicectl list devices 2>/dev/null \
        | awk '$4 == "connected" {print $3}' \
        | head -1)
fi

if [ -z "${DEVICE_ID:-}" ]; then
    echo ""
    echo "연결된 iPhone을 찾지 못했습니다."
    echo "  1) USB로 연결하고 기기에서 '이 컴퓨터를 신뢰' 를 눌렀는지 확인하세요."
    echo "  2) 기기 목록:  xcrun devicectl list devices"
    echo "  3) 직접 지정:  ./resign-ios.sh <device-id>"
    exit 1
fi

echo "==> 대상 기기: $DEVICE_ID"
echo "==> 빌드 및 서명"
xcodebuild \
    -project ios/App/App.xcodeproj \
    -scheme App \
    -configuration Debug \
    -destination "id=$DEVICE_ID" \
    -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates \
    build

echo "==> 설치"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH"

echo ""
echo "완료. 앱이 실행되지 않으면 iPhone에서"
echo "설정 > 일반 > VPN 및 기기 관리 > 개발자 앱 에서 인증서를 신뢰하세요."
