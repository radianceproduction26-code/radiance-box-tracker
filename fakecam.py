"""Helpers for the fake-camera tests: render the app's real labels to images, then build a y4m video that Chromium plays as the camera."""
import os
import numpy as np, cv2

W, H, FPS = 1280, 720, 10

def render_label_shots(browser, base, boxes, out_dir):
    """Screenshots of the printed label of each box (rendered by the app's own label code). Returns {box_id: image}."""
    ctx = browser.new_context(device_scale_factor=3, viewport={'width': 900, 'height': 1100}); pg = ctx.new_page()
    pg.goto(base); pg.wait_for_selector('#lf')
    rows = [dict(box_id=b['box_id'], part_no=b['part_no'], part_name=b['part_name'], qty=b['qty'], lot=b['lot'], label_date=b['label_date'], qa_sign=b['qa_sign'], pp_box_code=b['pp_box_code'], tray_no=b['tray_no']) for b in boxes]
    pg.evaluate("""async (rows) => { const L = await import('./js/labels.js');
        const d = document.createElement('div'); d.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:99;padding:10px;overflow:auto';
        d.innerHTML = L.labelsHtml(rows); document.body.appendChild(d); L.fitLabels(d); d.querySelectorAll('.lb').forEach((e) => { e.style.marginBottom = '10px'; }); }""", rows)
    shots = {}
    for b, el in zip(boxes, pg.query_selector_all('.lb')):
        el.scroll_into_view_if_needed()
        path = os.path.join(out_dir, 'cam_' + b['box_id'] + '.png'); el.screenshot(path=path); shots[b['box_id']] = cv2.imread(path)
    ctx.close()
    return shots

def scene(rng, img, width, angle=0, tilt=0, shift=(0, 0)):
    bg = np.full((H, W, 3), 150, np.uint8); bg += rng.integers(0, 14, (H, W, 3), dtype=np.uint8)
    if img is not None:
        h0, w0 = img.shape[:2]; sc = width / w0; im = cv2.resize(img, (int(w0 * sc), int(h0 * sc)), interpolation=cv2.INTER_AREA)
        h, w = im.shape[:2]
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]]); dst = np.float32([[0, 0], [w, tilt], [w, h - tilt], [0, h]])
        M_ = cv2.getPerspectiveTransform(src, dst); R = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
        R3 = np.vstack([R, [0, 0, 1]]) @ M_
        warped = cv2.warpPerspective(im, R3, (W, H), flags=cv2.INTER_LINEAR, borderValue=(0, 0, 0))
        mask = cv2.warpPerspective(np.full((h, w), 255, np.uint8), R3, (W, H))
        M2 = np.float32([[1, 0, W / 2 - w / 2 + shift[0]], [0, 1, H / 2 - h / 2 + shift[1]]])
        warped = cv2.warpAffine(warped, M2, (W, H)); mask = cv2.warpAffine(mask, M2, (W, H))
        bg = np.where(mask[..., None] > 0, warped, bg)
    bg = cv2.GaussianBlur(bg, (0, 0), 0.9)
    return np.clip(bg.astype(np.int16) + rng.normal(0, 5, bg.shape), 0, 255).astype(np.uint8)

def write_y4m(path, frames):
    with open(path, 'wb') as f:
        f.write(f'YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n'.encode())
        for fr in frames:
            f.write(b'FRAME\n'); f.write(cv2.cvtColor(fr, cv2.COLOR_BGR2YUV_I420).tobytes())
