#!/bin/sh
# 安装、卸载或查看 Tern Carly 启动适配（macOS）。
# install：把 ~/.local/bin/omp 从 Tern 管理的软链接换成 omp-launcher.sh，原链接目标记入备份文件。
# uninstall：按备份恢复原软链接。status：显示当前状态。
set -eu

link="$HOME/.local/bin/omp"
launcher=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)/omp-launcher.sh
backup="$HOME/.config/codex-cpa-gateway/omp-link.backup"

current_target() {
	if [ -L "$link" ]; then readlink "$link"; fi
}

case "${1:-status}" in
install)
	target=$(current_target)
	if [ "$target" = "$launcher" ]; then
		echo "already installed: $link -> $launcher"
		exit 0
	fi
	case $target in
	*"/Library/Application Support/Tern/omp/"*) ;;
	*)
		echo "refused: $link is not a symlink into Tern's managed omp (found: ${target:-not a symlink})" >&2
		exit 1
		;;
	esac
	mkdir -p "$(dirname "$backup")"
	chmod 700 "$(dirname "$backup")"
	printf '%s\n' "$target" >"$backup"
	chmod +x "$launcher"
	ln -sfn "$launcher" "$link"
	echo "installed: $link -> $launcher (previous target saved to $backup)"
	echo "Carly picks this up on her next omp start; quit and reopen Tern if she is already running."
	;;
uninstall)
	if [ "$(current_target)" != "$launcher" ]; then
		echo "not installed; $link left unchanged"
		exit 0
	fi
	if [ ! -r "$backup" ]; then
		echo "refused: no backup at $backup" >&2
		exit 1
	fi
	ln -sfn "$(cat "$backup")" "$link"
	echo "restored: $link -> $(cat "$backup")"
	;;
status)
	target=$(current_target)
	if [ "$target" = "$launcher" ]; then
		echo "installed: $link -> $launcher"
	else
		echo "not installed: $link -> ${target:-not a symlink}"
	fi
	;;
*)
	echo "usage: $0 install|uninstall|status" >&2
	exit 2
	;;
esac
