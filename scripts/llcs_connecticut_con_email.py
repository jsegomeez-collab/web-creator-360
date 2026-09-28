#!/usr/bin/env python3
"""
Empresas NUEVAS de Connecticut con EMAIL y ACTIVIDAD (NAICS), desde la API oficial y gratuita
del Secretary of the State (data.ct.gov, dataset "Business Master", se actualiza a diario).

Uso:
  python3 llcs_connecticut_con_email.py                 (últimos 14 días)
  python3 llcs_connecticut_con_email.py --dias 7 --solo-latinos
  python3 llcs_connecticut_con_email.py --sectores construccion,limpieza,belleza

Solo usa librerías que vienen con Python.
"""
import argparse
import csv
import datetime as dt
import json
import re
import unicodedata
import urllib.parse
import urllib.request

API = "https://data.ct.gov/resource/n7gp-d28j.json"

# Emails de gestorías / agentes registrados: no son del dueño, se descartan
DOMINIOS_GESTORIA = re.compile(
    r"incfile|zenbusiness|legalzoom|cscglobal|cscinfo|northwestregisteredagent|registeredagentsinc|"
    r"wolterskluwer|cogencyglobal|tailorbrands|swyftfilings|usa-llc-filing|corporatedocfiling|incorp\.com|"
    r"unitedagentgroup|corpcreations|rasi\.com|bizee|northwest|registeredagent|harborcompliance|"
    r"inc-?authority|mycompanyworks|govdocs|compliance",
    re.I,
)

# Sectores por prefijo NAICS (el código viene dentro del texto, p.ej. "Janitorial Services (561720)")
SECTORES = {
    "construccion": ("2361", "2362", "238"),
    "limpieza":     ("561720", "561740", "561790"),
    "jardineria":   ("561730",),
    "belleza":      ("8121",),
    "comida":       ("722", "3118"),
    "transporte":   ("484", "4921", "4922", "4885"),
    "taxes":        ("5412",),
    "auto":         ("8111", "4411", "4412"),
    "seguros":      ("5242",),
    "salud":        ("621",),
    "eventos":      ("5413", "7113", "5419", "8129"),
}
# Sociedades que no compran una web (holdings, alquiler de inmuebles, inversión)
NAICS_EXCLUIR = ("5311", "5239", "5511", "5251", "5259")

APELLIDOS = set("""
garcia rodriguez martinez hernandez lopez gonzalez perez sanchez ramirez torres flores rivera
gomez diaz reyes morales cruz ortiz gutierrez chavez ramos ruiz alvarez mendoza vasquez vazquez
castillo jimenez moreno romero herrera medina aguilar garza castro vargas fernandez guzman munoz
mendez salazar soto delgado pena rios alvarado sandoval contreras valdez guerrero ortega estrada
nunez maldonado vega dominguez luna rojas figueroa cabrera espinoza espinosa carrillo avila acosta
campos cervantes navarro fuentes marquez cortez cortes santiago rosales padilla molina suarez
juarez salinas solis cardenas pacheco miranda ibarra velasquez velazquez arias zamora orozco
cisneros trujillo calderon montoya benitez barrera villarreal rosario colon serrano duran ochoa
galvan hidalgo bautista paredes pineda zuniga macias valencia ayala beltran esquivel quintero
robles ponce rangel escobar bermudez villanueva gallegos mejia osorio tapia cuevas arellano
camacho lozano palacios quintana pizarro zapata rincon andrade barajas bonilla caballero
carrasco corona enriquez esparza gallardo granados guevara huerta lucero magana olivares
pantoja quiroz renteria rubio saldana santana segura tovar urbina zavala zepeda aguirre
arroyo bustamante chacon cordova cuellar duarte echeverria escamilla fajardo jaramillo
medrano montalvo murillo najera noriega ocampo perales quezada saenz sepulveda toledo uribe
valenzuela zarate carranza portillo henriquez amaya gonzales rodrigues machado betancourt
quinones feliciano melendez negron velez rosado burgos matos marrero irizarry pagan
""".split())
# Emails de gestorías latinas que registran empresas de muchos clientes
EMAILS_GESTOR = {"taxcenterct@gmail.com"}
# Nombres de sociedades patrimoniales o financieras (no compran una web)
RE_NO_OPERATIVA = re.compile(
    r"holding|propert|investment|funding|rentals|realty|capital|equity|trust\b|"
    r"limited liability partnership|enterprise management", re.I)

RE_ESPANOL = re.compile(
    r"servicios|latin[oa]|hispan|familia|nuestra|\blos\b|\blas\b|\bdel\b|\bel\b|y\s+m[aá]s|"
    r"limpieza|construccion|jardin|panaderia|taqueria|belleza|mudanza|mecanica|seguros|boricua|"
    r"sabor|cocina|\bcasa\b|\bmi\s",
    re.I,
)


def limpiar(t):
    t = unicodedata.normalize("NFKD", t or "")
    return "".join(c for c in t if not unicodedata.combining(c)).lower().strip()


def descargar(desde, limite=50000):
    where = (f"date_registration >= '{desde}T00:00:00' AND business_email_address IS NOT NULL "
             f"AND status = 'Active'")
    params = {"$where": where, "$limit": str(limite), "$order": "date_registration DESC"}
    url = API + "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def codigo_naics(texto):
    m = re.search(r"(\d{6})", texto or "")
    return m.group(1) if m else ""


def sector_de(naics):
    for nombre, prefijos in SECTORES.items():
        if naics.startswith(prefijos):
            return nombre
    return ""


def señales_latinas(nombre, email):
    motivos = []
    m = RE_ESPANOL.search(limpiar(nombre))
    if m:
        motivos.append(f"nombre: '{m.group(0).strip()}'")
    local = limpiar(email.split("@")[0])
    tokens = set(re.split(r"[^a-z]+", local))
    letras = re.sub(r"[^a-z]", "", local)
    # Palabra exacta; o al principio/final del email (5+ letras); o en medio solo si es largo (7+)
    encontrado = next((a for a in APELLIDOS if a in tokens), None) or \
        next((a for a in APELLIDOS if len(a) >= 5 and (letras.startswith(a) or letras.endswith(a))), None) or \
        next((a for a in APELLIDOS if len(a) >= 7 and a in letras), None)
    if encontrado:
        motivos.append(f"email: {encontrado}")
    return motivos


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dias", type=int, default=14, help="Empresas registradas en los últimos N días")
    p.add_argument("--sectores", help="Solo estos sectores, separados por comas")
    p.add_argument("--solo-latinos", action="store_true")
    p.add_argument("--json", help="(Pruebas) leer de un archivo JSON en vez de la API")
    p.add_argument("--salida", default="ct_nuevas_con_email.csv")
    a = p.parse_args()

    desde = (dt.date.today() - dt.timedelta(days=a.dias)).isoformat()
    if a.json:
        filas = json.load(open(a.json, encoding="utf-8"))
    else:
        print(f"Descargando empresas registradas desde {desde}...")
        filas = descargar(desde)
    solo = set(a.sectores.split(",")) if a.sectores else None

    from collections import Counter
    repetidos = Counter((f.get("business_email_address") or "").strip().lower() for f in filas)
    leads, descartadas_gestoria = [], 0
    for f in filas:
        email = (f.get("business_email_address") or "").strip()
        if not email or "@" not in email:
            continue
        if DOMINIOS_GESTORIA.search(email):
            alt = (f.get("category_survey_email_address") or "").strip()
            if alt and "@" in alt and not DOMINIOS_GESTORIA.search(alt):
                email = alt
            else:
                descartadas_gestoria += 1
                continue
        # Email compartido por 4+ empresas nuevas = gestoría, no el dueño
        if email.lower() in EMAILS_GESTOR or repetidos[email.lower()] >= 4:
            descartadas_gestoria += 1
            continue
        naics = codigo_naics(f.get("naics_code", ""))
        if naics.startswith(NAICS_EXCLUIR) or RE_NO_OPERATIVA.search(f.get("name", "")):
            continue
        sector = sector_de(naics)
        if solo and sector not in solo:
            continue
        nombre = f.get("name", "")
        motivos = señales_latinas(nombre, email)
        minoria = f.get("minority_owned_organization") in (True, "true", "True")
        if a.solo_latinos and not motivos:
            continue
        leads.append({
            "fecha_registro": (f.get("date_registration") or "")[:10],
            "empresa": nombre,
            "email": email,
            "sector": sector or "otro",
            "actividad_naics": f.get("naics_code", ""),
            "señal_latina": " + ".join(motivos),
            "declara_minoria": "SI" if minoria else "",
            "ciudad": (f.get("billingcity") or "").title(),
            "zip": (f.get("billingpostalcode") or "")[:5],
            "direccion": f.get("billingstreet", ""),
            "id_ct": f.get("accountnumber", ""),
        })

    leads.sort(key=lambda x: (x["señal_latina"] == "", x["sector"] == "otro", x["fecha_registro"]),
               reverse=False)
    with open(a.salida, "w", newline="", encoding="utf-8-sig") as out:
        if leads:
            w = csv.DictWriter(out, fieldnames=list(leads[0].keys()))
            w.writeheader()
            w.writerows(leads)

    latinos = sum(1 for l in leads if l["señal_latina"])
    print(f"Registros con email: {len(filas):,} | emails de gestoría descartados: {descartadas_gestoria:,}")
    print(f"Leads con email del negocio: {len(leads):,} (con señal latina: {latinos:,})")
    print(f"Guardado en: {a.salida}")


if __name__ == "__main__":
    main()
