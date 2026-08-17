#!/bin/bash
# --- Ajouter / retirer des mods du launcher EmeriaMC ---
# 1. Mets (ou supprime) tes .jar dans le dossier : content/mods/
# 2. Lance ce script : bash ajouter-mods.sh
# Il publie une nouvelle version -> tous les launchers se mettent à jour tout seuls.

cd "$(dirname "$0")" || exit 1

# Bump automatique de la version (0.2.1 -> 0.2.2 ...)
NEW=$(node -e "const p=require('./package.json');const v=p.version.split('.');v[2]=+v[2]+1;p.version=v.join('.');require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n');console.log(p.version)")

echo "Nouvelle version : v$NEW"
git add -A
git commit -m "maj mods (v$NEW)"
git tag "v$NEW"
git push
git push origin "v$NEW"

echo ""
echo "✅ Publié v$NEW ! Va voir le build : https://github.com/v9crf8tyfv-coder/EmeriaLauncher/actions"
echo "Quand c'est vert, tout le monde reçoit les nouveaux mods automatiquement."
