#!/bin/bash
cd "$(dirname "$0")"
PIDFILE=server.pid
LOGFILE=server.log
do_start() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then echo "已在运行 (PID $(cat $PIDFILE))"; return; fi
  command -v node >/dev/null 2>&1 || { echo "错误: 未找到 node，请先安装 Node.js (v14+)"; exit 1; }
  nohup node server.js > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  # 等待服务就绪并从日志提取本次启动的访问密钥
  KEY=""
  for i in $(seq 1 30); do
    KEY=$(grep -oE '访问密钥: [0-9A-Fa-f]+' "$LOGFILE" 2>/dev/null | tail -1 | awk '{print $2}')
    [ -n "$KEY" ] && break
    kill -0 "$(cat $PIDFILE)" 2>/dev/null || { echo "启动失败，请查看 $LOGFILE"; return; }
    sleep 0.3
  done
  echo "已启动 (PID $(cat $PIDFILE))"
  echo "============================================================"
  if [ -n "$KEY" ]; then
    echo "本次启动的访问密钥: $KEY"
    echo "浏览器首次打开页面需输入该密钥校验；服务重启后密钥与会话均会更新，需重新校验。"
  else
    echo "未能自动获取访问密钥，请查看 $LOGFILE"
  fi
  echo "============================================================"
}
do_stop() {
  if [ -f "$PIDFILE" ]; then kill "$(cat $PIDFILE)" 2>/dev/null && echo "已停止" || echo "进程不存在"; rm -f "$PIDFILE"; else echo "未在运行"; fi
}
case "$1" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  status) if [ -f "$PIDFILE" ] && kill -0 "$(cat $PIDFILE)" 2>/dev/null; then echo "运行中 (PID $(cat $PIDFILE))"; else echo "未运行"; fi ;;
  *) echo "用法: $0 {start|stop|restart|status}" ;;
esac
