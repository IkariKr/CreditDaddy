#!/usr/bin/env bash
# ==============================================================================
# CreditDaddy 自动同步与重构脚本 (保留本地性能优化补丁)
# ==============================================================================
set -e

REPO_DIR="D:/App/01_Ai/CodeX/CreditDaddy"
cd "$REPO_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 正在检查 CreditDaddy 官方上游 (upstream/main) 更新..."

# 1. 获取官方最新提交
git fetch upstream main --quiet

UPSTREAM_COMMIT=$(git rev-parse upstream/main)
MERGE_BASE=$(git merge-base HEAD upstream/main 2>/dev/null || echo "")

if [ "$MERGE_BASE" = "$UPSTREAM_COMMIT" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 官方仓库无新提交，当前已是最新 ($UPSTREAM_COMMIT)，无需重构。"
    exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 检测到官方新提交 ($UPSTREAM_COMMIT)，准备开始自动合并与变基..."

# 2. 检查工作区是否干净
if ! git diff-index --quiet HEAD --; then
    echo "⚠️ 检测到工作区有未提交的临时修改，自动放弃以防止覆盖。请先保存或清理修改。"
    exit 1
fi

# 3. 确保在 my-perf-fix 分支上执行 rebase
git checkout my-perf-fix --quiet

if ! git rebase upstream/main; then
    echo "❌ 变基发生冲突！已自动终止变基并恢复到更新前的稳定版本。请手动检查代码冲突。"
    git rebase --abort
    exit 1
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 变基成功！本地性能补丁已无缝叠加在最新代码之上。"

# 4. 同步更新本地 main 分支与远程 Fork 仓库备份
git checkout main --quiet
git merge --ff-only upstream/main --quiet
git push origin main --quiet || true
git checkout my-perf-fix --quiet
git push -f origin my-perf-fix --quiet || true
echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 已将最新代码和优化补丁推送到 GitHub Fork (IkariKr/CreditDaddy) 备份。"

# 5. 重新生成并构建绿色产物
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 正在更新桌面壳资源并构建绿色版本..."
mkdir -p desktop/server
cp -r bin src package.json README.md CHANGELOG.md desktop/server/

# 检查 CreditDaddy 是否正在运行，若运行则先关闭
RUNNING=0
if tasklist 2>/dev/null | grep -qi "CreditDaddy.exe"; then
    RUNNING=1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 正在安全终止运行中的 CreditDaddy 实例..."
    taskkill //IM CreditDaddy.exe //T //F >/dev/null 2>&1 || true
    sleep 1
fi

cd desktop
npx electron-builder --win --dir --publish never >/dev/null 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ 构建成功！"

# 6. 如果此前在运行，则重启更新后的程序
if [ $RUNNING -eq 1 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 正在启动最新优化编译版 CreditDaddy..."
    powershell -NoProfile -Command "Start-Process '$REPO_DIR/desktop/dist/win-unpacked/CreditDaddy.exe'"
    sleep 2
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🎉 CreditDaddy 热更新重启完成！"
fi
