#!/usr/bin/env bash
set -euo pipefail

# ============================================
# chivox-local-mcp  编译 / 检查 / 发布 脚本
# ============================================
#
# 用法:
#   bash scripts/build.sh              # 仅编译
#   bash scripts/build.sh --check      # 编译 + 发布前检查
#   bash scripts/build.sh --publish    # 编译 + 检查 + 发布到 npm
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }
step()  { echo -e "\n${CYAN}── $* ──${NC}"; }

MODE="build"
if [ "${1:-}" = "--check" ];   then MODE="check";   fi
if [ "${1:-}" = "--publish" ]; then MODE="publish";  fi

cd "$PROJECT_DIR"

# ========== 1. 环境检查 ==========
step "1/5 环境检查"

if ! command -v node &>/dev/null; then
  error "未找到 node，请先安装 Node.js >= 18"; exit 1
fi
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js 版本过低 ($(node -v))，需要 >= 18"; exit 1
fi
info "Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
  error "未找到 npm"; exit 1
fi
info "npm $(npm -v)"

# ========== 2. 安装依赖 ==========
step "2/5 安装依赖"
npm install --no-fund --no-audit
info "依赖安装完成"

# ========== 3. 编译 ==========
step "3/5 编译 TypeScript"
rm -rf dist
npx tsc
chmod +x dist/index.js

if [ ! -f dist/index.js ]; then
  error "编译产物 dist/index.js 不存在"; exit 1
fi
info "编译成功 → dist/index.js"

# 仅编译模式到此结束
if [ "$MODE" = "build" ]; then
  echo ""
  info "编译完成。运行 --check 可做发布前检查，--publish 可直接发布。"
  exit 0
fi

# ========== 4. 发布前检查 ==========
step "4/5 发布前检查"
HAS_ERROR=0

# 4.1 shebang
if ! head -1 dist/index.js | grep -q '#!/usr/bin/env node'; then
  error "dist/index.js 缺少 shebang (#!/usr/bin/env node)"
  HAS_ERROR=1
else
  info "shebang ✓"
fi

# 4.2 package.json 必要字段
for field in name version description license main bin repository; do
  if ! node -e "const p=require('./package.json'); if(!p.$field) process.exit(1)" 2>/dev/null; then
    error "package.json 缺少字段: $field"
    HAS_ERROR=1
  fi
done
info "package.json 字段完整 ✓"

# 4.3 README 不为空
README_SIZE=$(wc -c < README.md | tr -d ' ')
if [ "$README_SIZE" -lt 100 ]; then
  error "README.md 内容过少 (${README_SIZE} bytes)，请补充文档"
  HAS_ERROR=1
else
  info "README.md (${README_SIZE} bytes) ✓"
fi

# 4.4 npm pack 预览
info "npm pack 预览:"
npm pack --dry-run 2>&1 | tail -n +2
echo ""

# 4.5 npm 登录状态
NPM_USER=$(npm whoami 2>/dev/null || echo "")
if [ -z "$NPM_USER" ]; then
  warn "npm 未登录 — 发布前需执行 npm login"
  if [ "$MODE" = "publish" ]; then HAS_ERROR=1; fi
else
  info "npm 已登录: $NPM_USER ✓"
fi

# 4.6 检查版本是否已存在
PKG_NAME=$(node -p "require('./package.json').name")
PKG_VERSION=$(node -p "require('./package.json').version")
REMOTE_VERSION=$(npm view "$PKG_NAME" version 2>/dev/null || echo "")
if [ "$REMOTE_VERSION" = "$PKG_VERSION" ]; then
  error "版本 $PKG_VERSION 已在 npm 上存在，请先在 package.json 中升级版本号"
  HAS_ERROR=1
elif [ -n "$REMOTE_VERSION" ]; then
  info "npm 上最新版本: $REMOTE_VERSION，本次发布: $PKG_VERSION ✓"
else
  info "包 $PKG_NAME 尚未发布过，本次版本: $PKG_VERSION ✓"
fi

if [ "$HAS_ERROR" -ne 0 ]; then
  echo ""
  error "发布前检查未通过，请修复上述问题"
  exit 1
fi

info "所有检查通过"

if [ "$MODE" = "check" ]; then
  echo ""
  info "检查完成。执行 --publish 可发布到 npm。"
  exit 0
fi

# ========== 5. 发布 ==========
step "5/5 发布到 npm"
echo ""
echo -e "  包名:    ${CYAN}${PKG_NAME}${NC}"
echo -e "  版本:    ${CYAN}${PKG_VERSION}${NC}"
echo -e "  用户:    ${CYAN}${NPM_USER}${NC}"
echo ""
read -rp "确认发布? (y/N) " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  info "已取消发布"
  exit 0
fi

npm publish --access public
echo ""
info "发布成功!"
echo ""
echo -e "  安装:  ${CYAN}npm install -g ${PKG_NAME}${NC}"
echo -e "  npx:   ${CYAN}npx ${PKG_NAME}${NC}"
echo ""
