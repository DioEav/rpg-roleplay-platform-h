; ─────────────────────────────────────────────────────────────────────────────
; Meadhall —— 卸载定制 (electron-builder nsis.include)
;
; 背景:本应用捆绑便携 PostgreSQL + Python,运行时数据写在
;   %APPDATA%\Meadhall\  (pgdata 数据库 / app 同步副本 / logs / config.json,约 180MB+)。
; 默认卸载器存在两类问题(群反馈「卸载后文件都还在,流氓软件」):
;   1) deleteAppDataOnUninstall=false 时根本不删上述数据目录 → 残留。
;   2) 即便开启删除,若 supervisor 起的【分离子进程 postgres.exe】仍在跑,pgdata 被锁 → 删不掉。
;      electron-builder 默认只结束主程序(Meadhall.exe),不会杀这个分离的 PG。
;
; 本脚本:卸载/更新最早期先停掉 PG + 主程序,确保后续文件删除不被锁;真卸载再兜底清数据目录。
; (多用户选择页 / "\n" 字面量 / "全新安装" 文案问题已由 package.json 改 oneClick:true 整体消除。)
; ─────────────────────────────────────────────────────────────────────────────

; un.onInit:卸载流程最早期。先停后台进程再做任何文件删除。
!macro customUnInit
  ; /T 连同子进程一起结束主程序;再单独结束捆绑的 PostgreSQL(分离进程,不在主程序进程树内)。
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  nsExec::Exec 'taskkill /F /IM "postgres.exe"'
  ; 给操作系统一点时间释放文件句柄,避免随后 RMDir 撞到仍被占用的 pgdata 文件。
  Sleep 800
!macroend

; customUnInstall 在卸载尾段执行。deleteAppDataOnUninstall=true 已会删
; $APPDATA\${APP_FILENAME} 等变体,但 productName 含空格、归一化后名字可能有出入;
; 这里按 electron 真实 userData 目录名("Meadhall")再兜底删一次,确保不留 180MB pgdata。
; ${isUpdated} 守卫:仅【真卸载】删用户数据,【升级】时保留(否则更新会清空玩家存档/数据库)。
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$APPDATA\Meadhall"
  ${endIf}
!macroend
