#!/usr/bin/env bash
set -u
LOG=/Users/sz-0203015357/Desktop/Narwal/oh-my-pi/tmp/moa-grill-verify.log
mkdir -p "$(dirname "$LOG")"
: > "$LOG"
echo "poller start $(date +%H:%M:%S)" >> "$LOG"
for i in $(seq 1 100); do
	sleep 12
	pane=$(tmux capture-pane -t moa-ux -p -S -70 2>/dev/null || echo "NO_SESSION")
	{
		echo "===== poll $i $(date +%H:%M:%S) ====="
		echo "$pane" | tail -40
		echo "$pane" | grep -E 'MOA:|调研|等待|推荐|enter select|enter submit|改写|Worker|MOA 完成|MOA 耗时|streaming|divergent' | tail -10 || true
	} >> "$LOG"

	if echo "$pane" | grep -qE 'MOA 完成|MOA 耗时|∪ moa|moa transcript'; then
		echo "[done] poll $i" >> "$LOG"
		exit 0
	fi
	if echo "$pane" | grep -q 'enter select'; then
		echo "[auto] select Enter" >> "$LOG"
		tmux send-keys -t moa-ux Enter
		sleep 1.2
		continue
	fi
	if echo "$pane" | grep -q 'enter submit'; then
		q=$(echo "$pane" | tr '\n' ' ')
		if echo "$q" | grep -qiE '维度|dimension|关心|方面'; then
			ans='架构定位, 能力边界, 生态'
		elif echo "$q" | grep -qiE '读者|受众|audience|谁看'; then
			ans='技术读者'
		elif echo "$q" | grep -qiE '深度|depth|多深|详细'; then
			ans='概览+关键差异'
		elif echo "$q" | grep -qiE '用途|目的|purpose|选型|竞品'; then
			ans='竞品分析'
		else
			ans='按默认推荐'
		fi
		echo "[auto] input: $ans" >> "$LOG"
		tmux send-keys -t moa-ux "$ans" Enter
		sleep 1.2
		continue
	fi
done
echo "[timeout]" >> "$LOG"
exit 1
