@echo off
:: Wrapper para NSSM — arranca Flask con el entorno correcto
cd /d "C:\Users\oswal\.gemini\antigravity\scratch\portfolio_web"
set PYTHONPATH=C:\Users\oswal\AppData\Roaming\Python\Python314\site-packages
set FLASK_ENV=production
"C:\Python314\python.exe" app.py
