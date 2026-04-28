
发送信息
请求
```BASH
POST /v1.0/robot/groupMessages/send HTTP/1.1
Host:api.dingtalk.com
x-acs-dingtalk-access-token:nvosnghskaknz8an3b82
Content-Type:application/json

{
  "msgParam" : "{\"content\":\"钉钉，让进步发生\"}",
  "msgKey" : "sampleText",
  "openConversationId" : "cid6KeBBLoveMJOGXoYKF5x7EeiodoA==",
  "robotCode" : "dingue4kfzdxbynxxxxxx",
  "coolAppCode" : "COOLAPP-1-10182EEDD1AC0BA600D9000J"
}
```
返回：
```BASH
HTTP/1.1 200 OK
Content-Type:application/json

{
  "processQueryKey" : "jkasdfb8va9hndjksnvzkj"
}
```
msgKey 格式：

文件类型

sampleFile

{
  "mediaId":"@lAz*********shRs5m2pRL",
  "fileName":"表格.xlsx",
  "fileType":"xlsx",
}

mediaId：通过上传媒体文件接口，获取media_id参数值。
fileName：文件名称。
fileType：文件类型。

说明
文件类型，支持xlsx、pdf、zip、rar、doc、docx格式。

----

图片类型

sampleImageMsg

{
  "photoURL": "xxxx"
}

说明 photoURL 可填写图片的完整URL路径，也可填写图片的 mediaId。mediaId 可通过上传媒体文件接口，获取 media_id 参数值。

---

media_id 获取方式：
请求：
```bash
curl --location --request POST 'https://oapi.dingtalk.com/media/upload?access_token=ACCESSTOKEN' \
--form 'media=@"C:/Users/Desktop/222.png"' \
--form 'type="file"'
```
返回
```json
{
    "errcode": 0,
    "errmsg": "ok",
    "media_id": "$iAEKAqNwbmcDBgTNAk",
    "created_at": 1605863153573,
    "type": "image"
}
```