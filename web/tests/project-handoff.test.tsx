// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../App';
import { Api } from '../lib/api';
vi.mock('@xterm/xterm', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {} }));
let settleMutations = async () => {};
afterEach(async () => { await act(settleMutations); cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
test.each(['new', 'existing', 'draft-save-failure'])('adding a project respects its destination and the prior draft (%s)', async kind => {
  const mutations = vi.spyOn(Api.prototype, 'mutate');
  settleMutations = async () => {
    await Promise.allSettled(mutations.mock.results.flatMap(result => result.type === 'return' ? [result.value] : []));
  };
  localStorage.clear(); sessionStorage.clear(); history.replaceState({}, '', '/');
  sessionStorage.setItem('harness.project', 'old');
  HTMLDialogElement.prototype.showModal = function() { this.open=true; };
  HTMLDialogElement.prototype.close = function() { this.open=false; };
  Element.prototype.scrollIntoView = vi.fn();
  const sockets:any[]=[]; const requests:any[]=[];
  let projects=[{id:'old',name:'Old Project',path:'/old'}];
  vi.stubGlobal('WebSocket', class { onopen=()=>{}; onclose=()=>{}; onmessage=(_:any)=>{}; close(){}; constructor(){sockets.push(this);} });
  vi.stubGlobal('fetch', vi.fn(async (url:string,init:any)=> {
    if(url==='/api/session') return {status:200,ok:true,json:async()=>({authenticated:true,csrf:'csrf',operationRecoveryProtocol:2})};
    const request=JSON.parse(init.body); requests.push(request);
    let result:any={};
    switch(request.method){
      case 'project/list':result={projects};break;
      case 'project/defaults':result={directory:'/projects'};break;
      case 'project/add':
      case 'project/create':{const added={id:'new',name:request.params.name,path:'/projects/New Project'};projects=[...projects,added];result=added;break;}
      case 'thread/list':case 'model/list':case 'collaborationMode/list':case 'environment/list': result={data:[],nextCursor:null};break;
      case 'prompt/list':result={prompts:[]};break;
      case 'defaults/read':result={model:'fixture',modelProvider:'openai'};break;
      case 'conversation/start':result={thread:{id:'started'}};break;
      case 'thread/read':result={thread:{id:'started',cwd:'/projects/New Project'}};break;
      case 'thread/session':result={requiresResume:false,thread:{id:'started'},model:'fixture',modelProvider:'openai'};break;
      case 'thread/history':result={turns:[],timeline:[],turnsComplete:true,timelineComplete:true,historyVersion:0,activeRealtimeSessionAtPageStart:null,complete:true,nextCursor:null};break;
    }
    return {status:200,ok:true,json:async()=>({ok:true,result})};
  }));
  render(<App/>);
  await screen.findByRole('button',{name:'Old Project'});
  await waitFor(()=>expect(sockets.length).toBe(1));
  await act(async()=>{sockets[0].onopen();sockets[0].onmessage({data:JSON.stringify({type:'state',data:{connected:true,runtime:{connected:true,epoch:'epoch',activity:{unknown:false,activeThreads:[],pendingStarts:0,terminals:0,processes:0,subscriptions:0}}}})});});
  if(kind === 'draft-save-failure') {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
      if(key.startsWith('harness.draft.v1.')) throw new Error('Fixture storage unavailable');
      return original.call(this,key,value);
    });
  }
  fireEvent.change(screen.getByRole('textbox',{name:'给 Codex 的消息'}),{target:{value:'Keep my old project draft'}});
  fireEvent.click(screen.getByRole('button',{name:'添加项目'}));
  if(kind === 'existing') {
    fireEvent.click(screen.getByRole('button',{name:'添加已有目录'}));
    fireEvent.change(screen.getByRole('textbox',{name:'服务器上的绝对目录'}),{target:{value:'/projects/New Project'}});
  }
  fireEvent.change(screen.getByRole('textbox',{name:'项目名称'}),{target:{value:'New Project'}});
  const save=within(screen.getByRole('dialog',{name:'添加项目'})).getByRole('button',{name:kind === 'existing' ? '添加项目' : '创建项目'});
  await waitFor(()=>expect(save.matches(':disabled')).toBe(false));
  fireEvent.click(save);
  expect(mutations).toHaveBeenCalledTimes(1);
  expect(mutations.mock.calls[0]![0]).toBe(kind === 'existing' ? 'project/add' : 'project/create');
  // The new row follows real IndexedDB admission, accepted receipt and acknowledgement.
  // Wait for that transaction explicitly before inspecting the resulting navigation.
  await act(async () => { await mutations.mock.results[0]!.value; });
  expect(requests.filter(row => row.method === 'project/create' || row.method === 'project/add')).toHaveLength(1);
  await screen.findByRole('button',{name:'New Project'});
  await waitFor(()=>expect(screen.queryByRole('dialog',{name:'添加项目'})).toBeNull());
  if(kind === 'draft-save-failure') {
    expect(screen.getByRole('button',{name:'Old Project'}).className).toContain('selected');
    expect(screen.getByRole('textbox',{name:'给 Codex 的消息'})).toHaveProperty('value','Keep my old project draft');
    expect(screen.getByText(/项目已添加。当前草稿尚未安全保存/)).toBeTruthy();
    expect(requests.some(row=>row.method === 'conversation/start')).toBe(false);
    return;
  }
  expect(screen.getByRole('button',{name:'Old Project'}).className).not.toContain('selected');
  expect(screen.getByRole('button',{name:'New Project'}).className).toContain('selected');
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'给 Codex 的消息'})).toHaveProperty('value',''));
  fireEvent.click(screen.getByRole('button',{name:'Old Project'}));
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'给 Codex 的消息'})).toHaveProperty('value','Keep my old project draft'));
  fireEvent.click(screen.getByRole('button',{name:'New Project'}));
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'给 Codex 的消息'})).toHaveProperty('value',''));
  fireEvent.change(screen.getByRole('textbox',{name:'给 Codex 的消息'}),{target:{value:'Build the new project'}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'发送消息'}).matches(':disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button',{name:'发送消息'}));
  await waitFor(()=>expect(requests.find(row=>row.method==='conversation/start')?.params.projectId).toBe('new'));
});
