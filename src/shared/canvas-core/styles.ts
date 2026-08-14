/** 画布样式。实时画布与导出的单文件 HTML 共用同一份，保证两处观感一致 */
export const CANVAS_CSS = `
.ufc-stage{position:relative;width:100%;height:100%;overflow:hidden;cursor:grab;touch-action:none;
  -webkit-user-select:none;user-select:none;
  background-image:radial-gradient(var(--grid) 1px,transparent 1px);background-size:24px 24px}
.ufc-stage.grabbing{cursor:grabbing}
.ufc-world{position:absolute;transform-origin:0 0}
.ufc-world img{-webkit-user-drag:none;user-select:none;pointer-events:none}
body.ufc-selectable .ufc-card .ufc-head{-webkit-user-select:text;user-select:text;cursor:text}

.ufc-wires{position:absolute;left:0;top:0;pointer-events:none}
.ufc-edge{fill:none;stroke-width:1.6}
.ufc-edge.primary{stroke:var(--accent)}
.ufc-edge.branch{stroke:var(--branch);stroke-dasharray:7 5}
.ufc-edge.back{stroke:var(--back);stroke-dasharray:2 5}
.ufc-edge.link{stroke:var(--link);stroke-dasharray:12 6}
.ufc-ah-primary{fill:var(--accent)}.ufc-ah-branch{fill:var(--branch)}
.ufc-ah-back{fill:var(--back)}.ufc-ah-link{fill:var(--link)}

/* --dy 是避让层写进来的纵向偏移。默认值必须写在这里：缺省时 var(--dy) 无效，
   整条 transform 会失效，脚本执行之前标注要先跳一次位。
   宽度封顶是为了长标注——录制出来的动作串能到上百字，不封顶必然横向溢出，
   完整文本挂在 title 上 */
.ufc-label{position:absolute;--dy:0px;transform:translate(-50%,calc(-50% + var(--dy)));
  padding:3px 9px;border-radius:999px;
  background:var(--panel-2);border:1px solid var(--line);color:var(--fg);font-size:12px;white-space:nowrap;
  max-width:300px;overflow:hidden;text-overflow:ellipsis;
  box-shadow:0 2px 10px rgba(0,0,0,.25);z-index:2}
.ufc-label[data-anchor="end"]{transform:translate(-100%,calc(-50% + var(--dy)))}
.ufc-label[data-anchor="start"]{transform:translate(0,calc(-50% + var(--dy)))}
/* 左边放不下时由避让层翻边：整条改为从线的右侧 16px 起排 */
.ufc-label[data-anchor="end"][data-flip="1"]{transform:translate(16px,calc(-50% + var(--dy)))}
.ufc-label.branch{border-color:var(--branch);color:var(--branch)}
.ufc-label.back{border-color:var(--back);color:var(--back)}
.ufc-label.link{border-color:var(--link);color:var(--link)}

.ufc-lane{position:absolute;border:1px dashed var(--line);border-radius:16px;background:rgba(127,127,127,.035)}
.ufc-lane-title{position:absolute;left:16px;top:12px;font-size:18px;font-weight:700;letter-spacing:.02em}
.ufc-lane-title span{margin-left:10px;font-size:12px;font-weight:400;color:var(--muted)}

.ufc-card{position:absolute;background:var(--panel);border:1px solid var(--line);border-radius:14px;
  overflow:hidden;box-shadow:0 8px 26px rgba(0,0,0,.28)}
.ufc-card.validation{border-color:var(--branch)}
.ufc-card.manual{border-style:dashed}
.ufc-card.is-new{animation:ufc-pop .5s ease-out}
@keyframes ufc-pop{from{transform:scale(.94);opacity:.3}to{transform:scale(1);opacity:1}}
.ufc-card .ufc-head{padding:10px 12px 8px}
.ufc-card .ufc-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.ufc-card .ufc-num{font:600 12px/1 ui-monospace,Consolas,monospace;color:var(--muted)}
.ufc-card .ufc-tag{font-size:11px;padding:2px 7px;border-radius:6px;background:var(--panel-2);color:var(--muted)}
.ufc-card.validation .ufc-tag{color:var(--branch)}
.ufc-card .ufc-title{font-weight:600;font-size:14px}
.ufc-card .ufc-sub{font-size:11.5px;color:var(--muted);margin-top:1px;word-break:break-word}
.ufc-card .ufc-note{font-size:11.5px;color:var(--muted);margin-top:5px;border-top:1px solid var(--line);padding-top:5px}
.ufc-card .ufc-shot{background:#000;display:flex;align-items:center;justify-content:center}
.ufc-card .ufc-shot img{width:100%;display:block}
.ufc-hidden{display:none!important}
`
