#!/bin/bash
set -e

APP_NAME="Silence Cutter"
IDENTIFIER="com.yourstudio.silencecutterae"
VERSION="1.0.0"
SRC_DIR="SilenceCutterAE"

BUILD_ROOT="$(mktemp -d)"
SCRIPTS_DIR="$BUILD_ROOT/scripts"
RESOURCES_DIR="$BUILD_ROOT/resources"
mkdir -p "$SCRIPTS_DIR" "$RESOURCES_DIR/SilenceCutterAE"

# 1. Automatically install macOS node dependencies if client folder exists
if [ -d "$SRC_DIR/client" ]; then
  echo "Installing macOS Node modules..."
  cd "$SRC_DIR/client"
  npm install --os=darwin --cpu=x64 --build-from-source || npm install
  cd -
fi

# 2. Stage extension files
echo "Staging extension files into package resources..."
cp -R "$SRC_DIR"/* "$RESOURCES_DIR/SilenceCutterAE/"

# Make sure permissions are correct
chmod -R 755 "$RESOURCES_DIR/SilenceCutterAE"

# 3. Create robust postinstall script
cat > "$SCRIPTS_DIR/postinstall" << 'ENDOFSCRIPT'
#!/bin/bash
set -e

REAL_USER="${SUDO_USER:-$(logname)}"
REAL_HOME=$(eval echo "~$REAL_USER")
DEST="$REAL_HOME/Library/Application Support/Adobe/CEP/extensions/SilenceCutterAE"

# Locate Resources folder reliably during PKG installation
PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$PACKAGE_DIR/../Resources/SilenceCutterAE"

if [ ! -d "$SRC" ]; then
  SRC="$PACKAGE_DIR/../resources/SilenceCutterAE"
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
chown -R "$REAL_USER" "$DEST"

# Enable PlayerDebugMode for CSXS versions 9 through 18 (AE CC 2019 to 2026+)
for v in $(seq 9 18); do
  sudo -u "$REAL_USER" defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done

exit 0
ENDOFSCRIPT

chmod +x "$SCRIPTS_DIR/postinstall"

# 4. Build Component Package
echo "Building component package..."
pkgbuild \
  --nopayload \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --scripts "$SCRIPTS_DIR" \
  --resources "$RESOURCES_DIR" \
  "$BUILD_ROOT/component.pkg"

# 5. Build Final Installer
echo "Building product archive..."
productbuild \
  --package "$BUILD_ROOT/component.pkg" \
  "SilenceCutterSetup.pkg"

echo "Build complete: SilenceCutterSetup.pkg"