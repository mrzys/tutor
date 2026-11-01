//! Read-only source comparison. Full-page OCR images are never question crops.
use super::*;

fn text_asset_context(store: &Store, record: &Value, text: &str, page: u64, import_root: &Path) -> AppResult<Value> {
    // Text/DOCX imports without preserved OCR keep the existing question-context
    // fallback. OCR material is rendered only inside this teacher review view.
    if !record["ocrSource"].is_object() { return Ok(Value::Null); }
    let mut context = json!({"_sourceReviewOnly":true,"student":{"assets":[]},"teacher":{"assets":[]},"assetPayloads":[]});
    let reference = regex::Regex::new(r#"!\[[^\]]*\]\(([^)]+)\)|(?i:<img\s[^>]*src=[\"']([^\"']+)[\"'])"#).unwrap();
    let assets = rows(&record["ocrSource"]["assets"]);
    let mut seen = HashSet::new();
    for found in reference.captures_iter(text) {
        let token = found.get(1).or_else(||found.get(2)).map(|v|v.as_str()).unwrap_or("").trim().trim_start_matches("asset:");
        if !seen.insert(token.to_owned()) { continue; }
        let matching = assets.iter().filter(|asset| asset["id"] == token).collect::<Vec<_>>();
        if matching.len()!=1 || matching[0]["role"]=="source_page" || matching[0]["page"].as_u64()!=Some(page) {
            return Err(err("source_asset_unresolved","识别原文配图身份或来源页不一致，请对照原图核对。"));
        }
        let asset = matching[0];
        let path = store.data_dir.join(s(asset,"relativePath")).canonicalize()?;
        if !path.starts_with(import_root) || !path.is_file() {
            return Err(err("source_changed","识别原文配图不属于当前导入记录。"));
        }
        if std::fs::metadata(&path)?.len()>20*1024*1024 { return Err(err("source_changed","识别原文配图大小无效。")); }
        let bytes = std::fs::read(path)?;
        let valid_type = matches!((s(asset,"mimeType"),image::guess_format(&bytes)),
            ("image/png",Ok(image::ImageFormat::Png)) | ("image/jpeg",Ok(image::ImageFormat::Jpeg))
            | ("image/webp",Ok(image::ImageFormat::WebP)) | ("image/gif",Ok(image::ImageFormat::Gif)));
        if bytes.is_empty() || sha(&bytes)!=asset["sha256"] || !valid_type {
            return Err(err("source_changed","识别原文配图内容或格式校验失败。"));
        }
        let reference = json!({"assetId":asset["id"],"path":format!("ocr/{}.png",&hash_json(&asset["id"])[..32]),
            "sha256":asset["sha256"],"mimeType":asset["mimeType"],"alt":if asset["role"]=="table"{"原卷表格"}else{"原卷配图"}});
        let mut payload = reference.clone();
        payload["role"] = json!("teacher");
        payload["dataBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
        context["teacher"]["assets"].as_array_mut().unwrap().push(reference);
        context["assetPayloads"].as_array_mut().unwrap().push(payload);
    }
    Ok(context)
}

pub(super) fn read(store: &Store, payload: &Value) -> AppResult<Value> {
    let record = store.document("imports", s(payload, "importId"))?;
    // Checks the original, OCR manifest and every referenced asset before exposing
    // any material. Opening this view never performs OCR or a model request.
    let original = read_source(store, &record)?;
    let source_path = store
        .data_dir
        .join(s(&record["source"], "relativePath"))
        .canonicalize()?;
    let import_root = source_path
        .parent()
        .ok_or_else(|| err("invalid_source", "原卷目录无效。"))?;
    if record["ocrSource"].is_object() {
        let manifest_path = store
            .data_dir
            .join(s(&record["ocrSource"], "manifestRelativePath"))
            .canonicalize()?;
        if !manifest_path.starts_with(import_root) {
            return Err(err("source_changed", "识别原文不属于当前导入记录。"));
        }
    }
    let page = payload["page"]
        .as_u64()
        .filter(|p| *p > 0)
        .ok_or_else(|| err("invalid_page", "请选择有效的原卷页码。"))?;
    let pages = rows(&record["ocrSource"]["pages"]);
    let extracted = rows(&record["extractedPages"]);
    let mut page_count = pages
        .iter()
        .filter_map(|p| p["page"].as_u64())
        .max()
        .unwrap_or(extracted.len() as u64);
    if page_count == 0 {
        let pdf = if record["source"]["extension"] == "pdf" {
            Some(original)
        } else if record["renderedPdf"].is_object() {
            Some(paddle::read_rendered_pdf(store, &record)?)
        } else {
            None
        };
        if let Some(bytes) = pdf {
            page_count = lopdf::Document::load_mem(&bytes)
                .map(|pdf| pdf.get_pages().len() as u64)
                .map_err(|_| err("invalid_source", "已保存的原卷 PDF 无法读取页码。"))?;
        }
    }
    if page > page_count || page_count == 0 {
        return Err(err("invalid_page", "此页不在已保存的原卷范围内。"));
    }
    let requested_question = if payload.get("questionId").is_some() {
        Some(rows(&record["questions"]).into_iter()
            .find(|question| question["questionId"] == payload["questionId"]
                && rows(&question["pages"]).iter().any(|number| number.as_u64() == Some(page)))
            .ok_or_else(|| err("invalid_page", "此原页不属于当前题目，未使用其它题目的定位信息。"))?)
    } else { None };
    let layout = pages.iter().find(|value| value["page"].as_u64() == Some(page));
    let text = pages
        .iter()
        .find(|p| p["page"].as_u64() == Some(page))
        .and_then(|p| p["text"].as_str())
        .or_else(|| extracted.get(page as usize - 1).and_then(Value::as_str))
        .unwrap_or("");
    let assets = rows(&record["ocrSource"]["assets"]);
    let images: Vec<_> = assets
        .iter()
        .filter(|a| a["role"] == "source_page" && a["page"].as_u64() == Some(page))
        .collect();
    if images.len() > 1 {
        return Err(err(
            "source_changed",
            "原页图像身份不唯一，未选择任意副本。",
        ));
    }
    let image = if let Some(asset) = images.first() {
        let path = store
            .data_dir
            .join(s(asset, "relativePath"))
            .canonicalize()?;
        if !path.starts_with(import_root) || !path.is_file() {
            return Err(err("source_changed", "原页图像不属于当前导入记录。"));
        }
        let bytes = std::fs::read(path)?;
        if bytes.is_empty()
            || bytes.len() > 20 * 1024 * 1024
            || sha(&bytes) != s(asset, "sha256")
            || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        {
            return Err(err(
                "source_changed",
                "原页图像校验失败，请保留原件重新导入。",
            ));
        }
        let dimensions = (bytes.len() >= 24 && &bytes[12..16] == b"IHDR").then(|| (
            u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
            u32::from_be_bytes(bytes[20..24].try_into().unwrap())
        ));
        json!({"assetId":asset["id"],"width":dimensions.map(|size|size.0),"height":dimensions.map(|size|size.1),
            "mimeType":"image/png","dataBase64":base64::engine::general_purpose::STANDARD.encode(&bytes),"sha256":sha(&bytes)})
    } else {
        Value::Null
    };
    // The manifest and assets were verified by read_source. Only geometry for
    // persisted ownership is returned; clients cannot supply a box to approve.
    let page_layout = layout.filter(|layout| !image.is_null()
        && layout["sourceImageAssetId"] == image["assetId"]).map(|layout| {
        let transform = &layout["coordinateTransform"];
        let owned = requested_question.as_ref().map(|question| ids(&question["sourceBlockIds"]));
        let blocks = rows(&layout["blocks"]).into_iter().filter(|block| {
            block["id"].as_u64().is_some_and(|id| owned.as_ref()
                .is_none_or(|ids| ids.contains(&format!("p{page}-b{id}"))))
        }).map(|block|json!({"id":block["id"],"bbox":block["bbox"]})).collect::<Vec<_>>();
        json!({"page":page,"width":layout["width"],"height":layout["height"],
            "sourceImageAssetId":layout["sourceImageAssetId"],"blocks":blocks,
            "coordinateTransform":{"kind":transform["kind"],"layoutWidth":transform["layoutWidth"],
                "layoutHeight":transform["layoutHeight"],"imageWidth":transform["imageWidth"],
                "imageHeight":transform["imageHeight"],"rounding":transform["rounding"]}})
    }).unwrap_or(Value::Null);
    let mut result = json!({"importId":record["importId"],"page":page,"pageCount":page_count,"text":text,"image":image,
        "questionId":requested_question.map(|question|question["questionId"].clone()),"pageLayout":page_layout,
        "hasPdf":record["source"]["extension"]=="pdf" || record["renderedPdf"].is_object(),
        "sourceKind":if image.is_null(){"original_pdf"}else{"paddle_original_page"}});
    if payload["includeTextAssets"]==true { result["context"] = text_asset_context(store,&record,text,page,import_root)?; }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Store, Value) {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::open(directory.path(), &crate::bank::tests::seed()).unwrap();
        let source = save_source(
            &store,
            "simulated-source-compare",
            "pdf",
            b"%PDF-simulated-read-only",
        )
        .unwrap();
        let mut record = json!({"importId":"simulated-source-compare","source":source,"extractedPages":["模拟原文 $x^2$"],"questions":[]});
        let png = b"\x89PNG\r\n\x1a\nsimulated-hash-protected-page";
        let image = json!({"id":"p1-source","role":"source_page","page":1,"mimeType":"image/png","sha256":sha(png),"contentBase64":base64::engine::general_purpose::STANDARD.encode(png)});
        let audit_dir = store
            .data_dir
            .join("imports/simulated-source-compare/attempts/attempt-1");
        std::fs::create_dir_all(&audit_dir).unwrap();
        let audit_dir = audit_dir.canonicalize().unwrap();
        paddle::save_document(
            &store,
            &mut record,
            &crate::ocr::OcrDocument {
                pages: vec![json!({"page":1,"text":"模拟识别原文 $x^2$"})],
                assets: vec![image],
                issues: vec![],
            },
            &audit_dir,
            json!({"provider":"simulated"}),
        )
        .unwrap();
        save_cas(&store, None, &record).unwrap();
        (directory, store, record)
    }

    fn save_manifest(store: &Store, record: &mut Value) {
        let path=store.data_dir.join(s(&record["ocrSource"],"manifestRelativePath"));
        let mut manifest:Value=serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        manifest["assets"]=record["ocrSource"]["assets"].clone();
        manifest["pages"]=record["ocrSource"]["pages"].clone();
        let bytes=serde_json::to_vec(&manifest).unwrap();
        std::fs::write(path,&bytes).unwrap();
        record["ocrSource"]["manifestSha256"]=json!(sha(&bytes));
        store.put_document("imports",s(record,"importId"),record).unwrap();
    }

    fn text_asset_fixture() -> (tempfile::TempDir, Store, Value) {
        let (directory,store,mut record)=fixture();
        record["ocrSource"]["pages"]=json!([
            {"page":1,"text":"模拟同页多题原文 ![图](asset:sim-figure)\n![重复图](asset:sim-figure)\n<img src=\"asset:sim-table\" alt=\"原卷表格\">"},
            {"page":2,"text":"模拟第二页 ![另一页](asset:sim-other-page)"}
        ]);
        for (id,page,role,color) in [
            ("sim-figure",1,"figure",[0,0,200,255]),
            ("sim-table",1,"table",[200,0,0,255]),
            ("sim-unreferenced",1,"figure",[0,200,0,255]),
            ("sim-other-page",2,"figure",[200,200,0,255])
        ] {
            let mut bytes=Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(2,2,image::Rgba(color)))
                .write_to(&mut bytes,image::ImageFormat::Png).unwrap();
            let bytes=bytes.into_inner();
            let relative=format!("imports/simulated-source-compare/{id}.png");
            std::fs::write(store.data_dir.join(&relative),&bytes).unwrap();
            record["ocrSource"]["assets"].as_array_mut().unwrap().push(json!({
                "id":id,"page":page,"role":role,"mimeType":"image/png","sha256":sha(&bytes),"relativePath":relative
            }));
        }
        // No complete question detail is needed to read a page's OCR materials.
        record["questions"]=json!([{"questionId":"sim-unloaded","pages":[1],"_detailLoaded":false}]);
        save_manifest(&store,&mut record);
        (directory,store,record)
    }

    #[test]
    fn source_text_context_is_opt_in_page_scoped_deduplicated_and_read_only() {
        let (_dir,store,record)=text_asset_fixture();
        let plain=read(&store,&json!({"importId":record["importId"],"page":1})).unwrap();
        assert!(plain.get("context").is_none());
        let with_assets=read(&store,&json!({"importId":record["importId"],"page":1,"includeTextAssets":true})).unwrap();
        let context=&with_assets["context"];
        assert_eq!(context["_sourceReviewOnly"],true);
        assert!(rows(&context["student"]["assets"]).is_empty());
        assert_eq!(rows(&context["teacher"]["assets"]).iter().map(|a|s(a,"assetId").to_owned()).collect::<Vec<_>>(),vec!["sim-figure","sim-table"]);
        assert_eq!(rows(&context["assetPayloads"]).len(),2);
        for payload in rows(&context["assetPayloads"]) {
            assert_eq!(payload["role"],"teacher");
            let bytes=base64::engine::general_purpose::STANDARD.decode(s(&payload,"dataBase64")).unwrap();
            assert_eq!(payload["sha256"],sha(&bytes));
            assert_eq!(image::guess_format(&bytes).unwrap(),image::ImageFormat::Png);
        }
        for id in ["p1-source","sim-unreferenced","sim-other-page"] { assert!(!context.to_string().contains(id)); }
        let mut without=with_assets.clone();without.as_object_mut().unwrap().remove("context");
        assert_eq!(without,plain);
        let second=read(&store,&json!({"importId":record["importId"],"page":2,"includeTextAssets":true})).unwrap();
        assert_eq!(second["context"]["teacher"]["assets"][0]["assetId"],"sim-other-page");
        assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);
    }

    #[test]
    fn source_text_context_rejects_full_pages_wrong_pages_missing_and_ambiguous_assets() {
        for token in ["p1-source","sim-other-page","sim-missing","sim-figure"] {
            let (_dir,store,mut record)=text_asset_fixture();
            record["ocrSource"]["pages"][0]["text"]=json!(format!("![模拟图片](asset:{token})"));
            if token=="sim-figure" {
                let duplicate=record["ocrSource"]["assets"][1].clone();
                record["ocrSource"]["assets"].as_array_mut().unwrap().push(duplicate);
            }
            save_manifest(&store,&mut record);
            assert_eq!(read(&store,&json!({"importId":record["importId"],"page":1,"includeTextAssets":true})).unwrap_err().code,"source_asset_unresolved","{token}");
        }
    }

    #[test]
    fn source_text_context_rejects_tampered_or_foreign_crop_and_preserves_text_import_fallback() {
        let (_dir,store,record)=text_asset_fixture();
        let crop=record["ocrSource"]["assets"][1].clone();
        std::fs::write(store.data_dir.join(s(&crop,"relativePath")),b"tampered crop").unwrap();
        assert_eq!(read(&store,&json!({"importId":record["importId"],"page":1,"includeTextAssets":true})).unwrap_err().code,"source_changed");
        let (_dir,store,mut record)=text_asset_fixture();
        let crop=record["ocrSource"]["assets"][1].clone();
        let foreign=store.data_dir.join("imports/another-simulated-import/crop.png");
        std::fs::create_dir_all(foreign.parent().unwrap()).unwrap();
        std::fs::copy(store.data_dir.join(s(&crop,"relativePath")),&foreign).unwrap();
        record["ocrSource"]["assets"][1]["relativePath"]=json!("imports/another-simulated-import/crop.png");
        save_manifest(&store,&mut record);
        assert_eq!(read(&store,&json!({"importId":record["importId"],"page":1,"includeTextAssets":true})).unwrap_err().code,"source_changed");
        let source=save_source(&store,"simulated-plain-text","txt",b"plain original").unwrap();
        let plain=json!({"importId":"simulated-plain-text","source":source,"extractedPages":["plain original"],"questions":[]});
        store.put_document("imports","simulated-plain-text",&plain).unwrap();
        let result=read(&store,&json!({"importId":"simulated-plain-text","page":1,"includeTextAssets":true})).unwrap();
        assert!(result["context"].is_null());
        assert_eq!(result["text"],"plain original");
    }

    #[test]
    fn source_page_read_keeps_full_page_and_text_without_writes() {
        let (_dir, store, before) = fixture();
        let value = read(&store, &json!({"importId":before["importId"],"page":1})).unwrap();
        assert_eq!(value["sourceKind"], "paddle_original_page");
        assert_eq!(value["text"], "模拟识别原文 $x^2$");
        assert_eq!(value["image"]["mimeType"], "image/png");
        assert_eq!(
            store.document("imports", s(&before, "importId")).unwrap(),
            before
        );
        assert!(read(&store, &json!({"importId":before["importId"],"page":2})).is_err());
    }

    #[test]
    fn source_focus_geometry_is_manifest_bound_question_scoped_and_read_only() {
        let (_dir, store, before) = fixture();
        let mut record = before.clone();
        record["questions"] = json!([{"questionId":"simulated-q1","pages":[1],"sourceBlockIds":["p1-b1"]}]);
        record["ocrSource"]["pages"][0] = json!({"page":1,"text":"识别原文保持不变",
            "width":100,"height":200,"sourceImageAssetId":"p1-source",
            "coordinateTransform":{"kind":"identity","layoutWidth":100,"layoutHeight":200,
                "imageWidth":100,"imageHeight":200,"rounding":"floor_min_ceil_max","privateProviderField":"not-returned"},
            "blocks":[{"id":1,"bbox":[10,20,90,40],"text":"本题文字不随几何重复传输"},
                {"id":2,"bbox":[10,60,90,80],"text":"其它题的文字"}]});
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        png.extend_from_slice(&100_u32.to_be_bytes()); png.extend_from_slice(&200_u32.to_be_bytes());
        let asset = &mut record["ocrSource"]["assets"][0];
        std::fs::write(store.data_dir.join(s(asset,"relativePath")),&png).unwrap();
        asset["sha256"] = json!(sha(&png));
        let manifest_path = store.data_dir.join(s(&record["ocrSource"],"manifestRelativePath"));
        let mut manifest:Value = serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["assets"] = record["ocrSource"]["assets"].clone();
        manifest["pages"] = record["ocrSource"]["pages"].clone();
        let bytes = serde_json::to_vec(&manifest).unwrap(); std::fs::write(&manifest_path,&bytes).unwrap();
        record["ocrSource"]["manifestSha256"] = json!(sha(&bytes));
        save_cas(&store,Some(&before),&record).unwrap();
        let payload = json!({"importId":record["importId"],"page":1,"questionId":"simulated-q1",
            "bbox":[0,0,100,200],"sourceBlockIds":["p1-b2"]});
        let value = read(&store,&payload).unwrap();
        assert_eq!(value["questionId"],"simulated-q1");
        assert_eq!(value["image"]["width"],100); assert_eq!(value["image"]["height"],200);
        assert_eq!(value["pageLayout"]["blocks"],json!([{"id":1,"bbox":[10,20,90,40]}]));
        assert!(value["pageLayout"]["coordinateTransform"].get("privateProviderField").is_none());
        assert!(value["pageLayout"]["blocks"][0].get("text").is_none());
        assert_eq!(store.document("imports",s(&record,"importId")).unwrap(),record);
        assert!(read(&store,&json!({"importId":record["importId"],"page":1,"questionId":"foreign"})).is_err());
        // Changing stored geometry without its manifest is rejected before any
        // geometry/image reaches the caller, even if source image bytes match.
        record["ocrSource"]["pages"][0]["blocks"][0]["bbox"] = json!([1,2,3,4]);
        store.put_document("imports",s(&record,"importId"),&record).unwrap();
        assert_eq!(read(&store,&payload).unwrap_err().code,"source_changed");
    }

    #[test]
    fn changed_page_bytes_are_rejected() {
        let (_dir, store, record) = fixture();
        let path = store
            .data_dir
            .join(s(&record["ocrSource"]["assets"][0], "relativePath"));
        std::fs::write(path, b"tampered").unwrap();
        let failure = read(&store, &json!({"importId":record["importId"],"page":1})).unwrap_err();
        assert_eq!(failure.code, "source_changed");
    }

    #[test]
    fn original_source_change_is_not_hidden_by_valid_page_image() {
        let (_dir, store, record) = fixture();
        std::fs::write(
            store.data_dir.join(s(&record["source"], "relativePath")),
            b"changed original",
        )
        .unwrap();
        assert_eq!(
            read(&store, &json!({"importId":record["importId"],"page":1}))
                .unwrap_err()
                .code,
            "source_changed"
        );
    }

    #[test]
    fn another_import_page_is_rejected_even_with_matching_hash() {
        let (_dir, store, before) = fixture();
        let mut record = before.clone();
        let original = store
            .data_dir
            .join(s(&record["ocrSource"]["assets"][0], "relativePath"));
        let foreign = store
            .data_dir
            .join("imports/another-simulated-import/page.png");
        std::fs::create_dir_all(foreign.parent().unwrap()).unwrap();
        std::fs::copy(original, &foreign).unwrap();
        record["ocrSource"]["assets"][0]["relativePath"] =
            json!("imports/another-simulated-import/page.png");
        let manifest_path = store
            .data_dir
            .join(s(&record["ocrSource"], "manifestRelativePath"));
        let mut manifest: Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        manifest["assets"] = record["ocrSource"]["assets"].clone();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(manifest_path, &bytes).unwrap();
        record["ocrSource"]["manifestSha256"] = json!(sha(&bytes));
        save_cas(&store, Some(&before), &record).unwrap();
        assert_eq!(
            read(&store, &json!({"importId":record["importId"],"page":1}))
                .unwrap_err()
                .message,
            "原页图像不属于当前导入记录。"
        );
    }
}
