import os
import shutil

bases = [r'C:\Users\asus\snapdoc', r'G:\マイドライブ\project\snapdoc']
src_node = r'C:\Users\asus\snapdoc\node_modules'

for b in bases:
    tess_dir = os.path.join(b, 'public', 'tesseract')
    core_dir = os.path.join(tess_dir, 'core')
    lang_dir = os.path.join(tess_dir, 'lang')
    os.makedirs(core_dir, exist_ok=True)
    os.makedirs(lang_dir, exist_ok=True)

    # 1. worker.min.js
    worker_src = os.path.join(src_node, 'tesseract.js', 'dist', 'worker.min.js')
    shutil.copy2(worker_src, os.path.join(tess_dir, 'worker.min.js'))

    # 2. core wasm & js
    core_src = os.path.join(src_node, 'tesseract.js-core')
    for f in os.listdir(core_src):
        fp = os.path.join(core_src, f)
        if os.path.isfile(fp):
            shutil.copy2(fp, os.path.join(core_dir, f))

    # 3. language models
    shutil.copy2(r'C:\Users\asus\snapdoc\vie_best.traineddata', os.path.join(lang_dir, 'vie.traineddata'))
    shutil.copy2(r'C:\Users\asus\snapdoc\eng.traineddata', os.path.join(lang_dir, 'eng.traineddata'))
    shutil.copy2(r'C:\Users\asus\snapdoc\jpn.traineddata', os.path.join(lang_dir, 'jpn.traineddata'))
    shutil.copy2(r'C:\Users\asus\snapdoc\chi_sim.traineddata', os.path.join(lang_dir, 'chi_sim.traineddata'))
    shutil.copy2(r'C:\Users\asus\snapdoc\chi_tra.traineddata', os.path.join(lang_dir, 'chi_tra.traineddata'))

print("All Tesseract offline assets (worker, core, and 5 language models) copied successfully to both repos!")
