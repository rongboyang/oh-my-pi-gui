# 个人分支：rebase 与双 Mac 部署

| 仓库 | 个人分支 | 更新来源 |
| --- | --- | --- |
| Core | [`rongboyang/oh-my-pi:remote-omp-ssh`](https://github.com/rongboyang/oh-my-pi/tree/remote-omp-ssh) | 新 GUI 版本的 `sidecar-source.json` 指向的公开 Core 提交 |
| GUI | [`rongboyang/oh-my-pi-gui:remote-omp-ssh`](https://github.com/rongboyang/oh-my-pi-gui/tree/remote-omp-ssh) | `nornzach/oh-my-pi-gui` 的新版本 tag |

两个 checkout 保持独立：Core 在外层，GUI 在它的 `packages/gui/`，两者的 `origin` 都指向对应的 `nornzach` 仓库，`personal` 指向 `rongboyang` fork。只推 `personal/remote-omp-ssh`，不推上游、不改任何 `main`、不发布正式安装包。

## 新版本到来时

在 M1 Max 的干净 checkout 上操作。首次配置可从 `nornzach` 仓库 clone，在两边分别 `git remote add personal` 指向上表中的个人 fork，再 `git fetch personal && git switch --track personal/remote-omp-ssh`。不要把 `packages/gui/` 加入 Core 的 Git。

```bash
# 从 Core 根目录执行；填要跟进的正式 GUI tag。
GUI_TAG=vX.Y.Z
GUI=packages/gui

git fetch origin main
git fetch personal remote-omp-ssh
git -C "$GUI" fetch origin main "refs/tags/$GUI_TAG:refs/tags/$GUI_TAG"
git -C "$GUI" fetch personal remote-omp-ssh

# 两边都先切到 remote-omp-ssh。保留 rebase 前的本机备份供回退。
backup="backup/remote-omp-ssh-$(date +%Y%m%d-%H%M%S)"
git branch "$backup"
git -C "$GUI" branch "$backup"
core_remote=$(git rev-parse personal/remote-omp-ssh)
gui_remote=$(git -C "$GUI" rev-parse personal/remote-omp-ssh)
core_old_base=$(git merge-base HEAD origin/main)
gui_old_base=$(git -C "$GUI" merge-base HEAD "refs/tags/$GUI_TAG")

# 只接受官方 GUI tag 里的正式 Core pin；不使用个人分支原有的 pin。
core_base=$(git -C "$GUI" show "refs/tags/$GUI_TAG:sidecar-source.json" | bun -e '
  const { repo, commit } = JSON.parse(await Bun.stdin.text());
  if (repo !== "nornzach/oh-my-pi" || !/^[0-9a-f]{40}$/.test(commit)) process.exit(1);
  console.log(commit);
')
git fetch origin "$core_base"
git rebase --onto "$core_base" "$core_old_base"
git -C "$GUI" rebase --onto "refs/tags/$GUI_TAG" "$gui_old_base"
```

发生冲突时先停在该步骤，不继续构建或部署。按 `git status` 解决后 `git rebase --continue`，需要撤回则 `git rebase --abort`。如果 GUI 的 `sidecar-source.json` 冲突，最终文件的 `repo` 必须为 `rongboyang/oh-my-pi`、`commit` 必须为 **rebase 后 Core 的完整 SHA**；即使没冲突也要更新并提交该 pin。记录 `git rev-parse HEAD` 和 `git -C packages/gui rev-parse HEAD`。若在新终端继续，从备份和自己的远端分支核对 `core_remote` / `gui_remote` 仍为 rebase 前的 SHA，不要盲目刷新 lease。

## 构建一次，部署同一份包

在 M1 Max（Bun 版本以 Core `package.json` 为准）构建，先跑本次冲突涉及的测试。构建脚本还会检查提交 pin、GUI 类型、GUI/Core 协议匹配以及打包 sidecar 的本机 RPC。

```bash
# 从 Core 根目录执行。
bun install --frozen-lockfile
(cd packages/gui && bun install --frozen-lockfile)
artifact="$HOME/Downloads/omp-personal-$(git -C packages/gui rev-parse --short HEAD).zip"
bash packages/gui/scripts/personal-mac.sh build "$artifact"

# 构建通过后，先发布 Core，再发布引用该提交的 GUI。
git push --force-with-lease=refs/heads/remote-omp-ssh:"$core_remote" personal HEAD:refs/heads/remote-omp-ssh
git -C packages/gui push --force-with-lease=refs/heads/remote-omp-ssh:"$gui_remote" personal HEAD:refs/heads/remote-omp-ssh
```

先退出两台机器上正在运行的 **omp Remote**，不用退出当前项目的远端 Core，也不用退出正式版 GUI。把脚本和同一个 ZIP 传到 M4 Pro（例如 `scp "$artifact" packages/gui/scripts/personal-mac.sh m4-pro:Downloads/`）。在两台机器上分别用构建输出的 **同一个 SHA256** 安装：

```bash
bash /path/to/personal-mac.sh install /path/to/omp-personal-REV.zip SHA256
```

安装脚本在两台机器上都写入 `~/Applications/omp Remote.app` 和 `~/.local/bin/omp`，校验 SHA256 及签名。原 `/Applications/omp.app` 不变。原 CLI 如存在，第一次安装时备份为 `~/.local/share/omp-remote/previous-omp`。个人包的 GUI 更新源是个人 fork；日常升级用本文流程，不点正式版本的升级链接。需要回退个人包时，退出个人 GUI 后，用保留的上一个 ZIP 和 SHA256 再安装一次。

## M1 Max 接入 M4 Pro

1. 在 M4 Pro 进入目标项目，启动 `omp remote serve --name my-project`。要在 SSH 终端退出后继续运行，可先进入 `tmux new -s omp-my-project`，启动后用 `Ctrl-b d` 分离。升级磁盘上的二进制不会中止已运行的实例；需要新能力时，等当前任务完成，再在 M4 Pro 重启该实例。
2. 在 M1 Max 运行 `ssh m4-pro omp remote list --json`，确认目标项目被列出。如果不是刚安装的 CLI，检查 M4 Pro 的**非交互** `PATH` 是否包含 `~/.local/bin`。
3. 打开个人版 GUI（显式使用独立配置，避免和正式版争用实例锁）：

   ```bash
   open -n "$HOME/Applications/omp Remote.app" --args --user-data-dir="$HOME/Library/Application Support/omp-remote"
   ```

   点击 **连接远端 omp**，选择 `m4-pro` 和相应实例，确认远端标识及项目路径。用一个测试工作区写入或预览文件，确认结果存在于 M4 Pro，而不在客户端同名目录中。
