#!/bin/sh
# Tern Carly 启动适配：由 tern/carly-launcher.sh install 链接到 ~/.local/bin/omp。
# Tern 以 GUI 环境、固定参数 --no-extensions 启动 Carly 的 omp，既读不到 shell 中的
# CPA 变量，也不加载本扩展。识别到 Carly 时（参数含 /Tern/carly/ 会话目录），先读取
# 环境文件，再用显式 -e 加载本扩展；其他调用原样转发给 Tern 管理的 omp。
# 只在 Carly 时读取环境文件，避免覆盖 shell 启动函数临时设置的变量。

real="$HOME/Library/Application Support/Tern/omp/bin/omp"
extension_dir=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
env_file="${CODEX_CPA_ENV_FILE:-$HOME/.config/codex-cpa-gateway/env}"

for arg do
	case $arg in
	*/Tern/carly/*)
		if [ -r "$env_file" ]; then
			. "$env_file"
		fi
		exec "$real" "$@" -e "$extension_dir"
		;;
	esac
done
exec "$real" "$@"
