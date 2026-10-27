#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
if [[ -x /usr/local/bin/node ]]; then
  /usr/local/bin/node scripts/open-personal-agent-p0.mjs
else
  node scripts/open-personal-agent-p0.mjs
fi
if [[ $? -ne 0 ]]; then
  echo '启动未完成。请保留上面的错误说明。按回车关闭。'
  read -r
fi
