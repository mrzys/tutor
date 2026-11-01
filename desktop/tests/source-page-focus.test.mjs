import test from 'node:test';
import assert from 'node:assert/strict';
import { sourcePageFocus } from '../src/source-page-focus.ts';
const source = () => ({questionId:'q1',page:1,image:{assetId:'page-1',width:200,height:400},pageLayout:{page:1,width:100,height:200,sourceImageAssetId:'page-1',coordinateTransform:{kind:'uniform_scale',layoutWidth:100,layoutHeight:200,imageWidth:200,imageHeight:400,rounding:'floor_min_ceil_max'},blocks:[{id:1,bbox:[10,20,90,40]},{id:2,bbox:[10,50,70,90]}]}});
test('模拟已校验原页坐标：按确切缩放映射整题多个块，原响应不修改', () => {
  const value=source(), original=JSON.stringify(value);
  assert.deepEqual(sourcePageFocus(value,'q1'),{boxes:[{left:10,top:10,width:80,height:10},{left:10,top:25,width:60,height:20}],bounds:{left:10,top:10,width:80,height:35}});
  assert.equal(JSON.stringify(value),original);
});
test('模拟身份或坐标依据缺失：不凭题号、页面比例或任意bbox猜测定位', () => {
  for (const change of [s=>s.questionId='q2',s=>s.page=2,s=>s.image.assetId='foreign',s=>s.pageLayout.coordinateTransform=null,s=>s.pageLayout.coordinateTransform.kind='rotate',s=>s.pageLayout.coordinateTransform.rounding=null,s=>s.image.height=390,s=>s.pageLayout.blocks=[],s=>s.pageLayout.blocks.push({...s.pageLayout.blocks[0]}),s=>s.pageLayout.blocks[0].bbox=[-1,0,20,30],s=>s.pageLayout.blocks[0].bbox=[1,2,101,30]]) {
    const value=source();change(value);assert.equal(sourcePageFocus(value,'q1'),null);
  }
});
test('模拟identity必须尺寸完全相同，缩放采用向外取整保留边缘', () => {
  const value=source();value.pageLayout.coordinateTransform.kind='identity';assert.equal(sourcePageFocus(value,'q1'),null);
  value.image.width=100;value.image.height=200;Object.assign(value.pageLayout.coordinateTransform,{imageWidth:100,imageHeight:200});
  value.pageLayout.blocks=[{id:1,bbox:[10.1,20.1,20.1,30.1]}];
  assert.deepEqual(sourcePageFocus(value,'q1').boxes,[{left:10,top:10,width:11,height:5.5}]);
});
