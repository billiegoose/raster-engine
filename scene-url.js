/* The scene query parameter identifies a saved scene, not an editor snapshot.
   Preserve unrelated URL parameters and fragments when changing files. */
const sceneParameter='scene';
const validName=/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

export function requestedSceneName(search){
  const parameter=new URLSearchParams(search).get(sceneParameter);
  if(parameter===null)return null;
  const name=parameter.trim().replace(/\.json$/i,'');
  return validName.test(name)?name:null;
}

export function hasSceneParameter(search){
  return new URLSearchParams(search).has(sceneParameter);
}

export function syncSceneUrl(location,history,name){
  const url=new URL(location.href);
  if(name)url.searchParams.set(sceneParameter,`${name}.json`);
  else url.searchParams.delete(sceneParameter);
  if(url.href!==location.href){
    history.replaceState(history.state,'',url.pathname+url.search+url.hash);
  }
}
