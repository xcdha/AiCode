#!/usr/bin/env bash
#
# 上游同步脚本：把 jieapi/AiCode（上游）的更新合回本仓库（xcdha/AiCode，二开分支）。
#
# 背景：本仓库是 AiCode 的二开版本，自定义改动都会带 `[二开]` 注释标记，
# 并且尽量落在「新增文件 + 小范围插入」上，所以常规情况下 rebase 不会产生冲突。
# 本脚本把「加 remote → 拉取 → 变基 → 推送」这套动作固化下来，避免每次手动敲错。
#
# 用法：
#   scripts/sync-upstream.sh              # 只检查：拉取上游并显示领先/落后情况，不改本地分支
#   scripts/sync-upstream.sh --rebase     # 把当前分支变基到上游 main 之上
#   scripts/sync-upstream.sh --merge      # 用 merge 的方式合入上游（保留二开分支的提交图）
#   scripts/sync-upstream.sh --push       # 变基/合并成功后，把结果推到 origin 当前分支
#
# 环境变量（一般不用改）：
#   UPSTREAM_URL     上游仓库地址，默认 https://github.com/jieapi/AiCode.git
#   UPSTREAM_BRANCH  上游分支，默认 main
#   ORIGIN_REMOTE    本仓库 remote 名，默认 origin
#
# 冲突处理：
#   变基中遇到冲突时脚本会停下并打印冲突文件。逐个解决后执行
#       git add <file> && git rebase --continue
#   想放弃本次同步、回到操作前的状态：
#       git rebase --abort        # 变基模式
#       git merge --abort         # 合并模式
#   本脚本不会自动 --force-push；变基后如需强推，请自己确认后手动执行。

set -euo pipefail

UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/jieapi/AiCode.git}"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
ORIGIN_REMOTE="${ORIGIN_REMOTE:-origin}"
UPSTREAM_REMOTE="upstream"

MODE="check"
DO_PUSH=0

for arg in "$@"; do
  case "$arg" in
    --rebase) MODE="rebase" ;;
    --merge)  MODE="merge" ;;
    --push)   DO_PUSH=1 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（用 --help 查看用法）" >&2
      exit 2
      ;;
  esac
done

# 必须在仓库根目录执行：脚本依赖 .git 与工作区同级。
cd "$(git rev-parse --show-toplevel)"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "$UPSTREAM_BRANCH" ] && [ "$MODE" != "check" ]; then
  # 二开改动建议放在独立分支上，避免直接动 main；这里只提示不阻断。
  echo "提示：当前分支为 $current_branch，二开改动建议在 feature 分支上同步后再合回 $UPSTREAM_BRANCH。"
fi

# 1. 确保 upstream remote 存在（只在本地 .git/config 生效，不影响仓库内容）。
if git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote set-url "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
else
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

echo "==> 拉取上游 $UPSTREAM_URL ($UPSTREAM_BRANCH)"
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

upstream_ref="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
behind="$(git rev-list --count "HEAD..$upstream_ref")"
ahead="$(git rev-list --count "$upstream_ref..HEAD")"

echo "==> 当前分支 $current_branch：落后上游 $behind 个提交，领先上游 $ahead 个提交（即二开提交）"

if [ "$behind" -gt 0 ]; then
  echo "==> 上游新增提交："
  git log --oneline --no-decorate "HEAD..$upstream_ref"
fi

if [ "$MODE" = "check" ]; then
  echo "==> 仅检查模式，未修改本地分支。要真正同步请加 --rebase 或 --merge。"
  exit 0
fi

if [ "$behind" -eq 0 ]; then
  echo "==> 上游没有新提交，无需同步。"
  exit 0
fi

# 变基/合并前要求工作区干净，否则容易把未提交的半成品混进冲突解决里。
if [ -n "$(git status --porcelain)" ]; then
  echo "工作区有未提交改动，请先 commit 或 stash 后再同步。" >&2
  git status --short >&2
  exit 1
fi

if [ "$MODE" = "rebase" ]; then
  echo "==> 变基到 $upstream_ref"
  if ! git rebase "$upstream_ref"; then
    echo "" >&2
    echo "变基中断，冲突文件如下：" >&2
    git diff --name-only --diff-filter=U >&2 || true
    echo "解决后：git add <file> && git rebase --continue ；放弃：git rebase --abort" >&2
    exit 1
  fi
else
  echo "==> 合并 $upstream_ref"
  if ! git merge --no-edit "$upstream_ref"; then
    echo "" >&2
    echo "合并中断，冲突文件如下：" >&2
    git diff --name-only --diff-filter=U >&2 || true
    echo "解决后：git add <file> && git commit ；放弃：git merge --abort" >&2
    exit 1
  fi
fi

echo "==> 同步完成。"
git log --oneline --no-decorate -5

if [ "$DO_PUSH" -eq 1 ]; then
  echo "==> 推送到 $ORIGIN_REMOTE/$current_branch"
  if [ "$MODE" = "rebase" ]; then
    # 变基会重写提交，非快进；二开分支通常只有自己在用，强推前给出明确提示。
    echo "注意：变基后需要强推（--force-with-lease）。如需强推请手动执行："
    echo "    git push --force-with-lease $ORIGIN_REMOTE $current_branch"
  else
    git push "$ORIGIN_REMOTE" "$current_branch"
  fi
fi
