@echo off
rem Normalizador de Videos - RTMP Panel
rem Duplo clique aqui para abrir a ferramenta.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Normalizador.ps1"
if errorlevel 1 pause
