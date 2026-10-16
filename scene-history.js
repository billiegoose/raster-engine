/* Undoable scene snapshots include selection, so redoing a paste or deletion
   restores the relevant selected objects. Group and text edits remain atomic. */
export function createSceneHistory({
  getScene,replaceScene,getSelection=()=>[],replaceSelection=()=>{},
  onChange=()=>{},onStateChange=()=>{},limit=100
}){
  const undoStack=[],redoStack=[];
  let pending=null;
  const snapshot=()=>({scene:JSON.stringify(getScene()),selection:structuredClone(getSelection())});
  const state=()=>({canUndo:undoStack.length>0,canRedo:redoStack.length>0,
                   undoDepth:undoStack.length,redoDepth:redoStack.length});
  const push=(stack,value)=>{stack.push(value);if(stack.length>limit)stack.shift();};
  function begin(){if(pending===null)pending=snapshot();}
  function commit({notify=true}={}){
    if(pending===null)return false;
    const before=pending,after=snapshot();
    pending=null;
    if(before.scene===after.scene)return false;
    push(undoStack,before);
    redoStack.length=0;
    if(notify)onChange();
    onStateChange(state());
    return true;
  }
  function transaction(action){begin();action();return commit();}
  function restore(from,to){
    commit({notify:false});
    if(!from.length)return false;
    push(to,snapshot());
    const previous=from.pop();
    replaceScene(JSON.parse(previous.scene));
    replaceSelection(previous.selection);
    onChange();onStateChange(state());
    return true;
  }
  return {
    begin,commit,transaction,
    undo:()=>restore(undoStack,redoStack),
    redo:()=>restore(redoStack,undoStack),
    reset(){pending=null;undoStack.length=0;redoStack.length=0;onStateChange(state());},
    state
  };
}
