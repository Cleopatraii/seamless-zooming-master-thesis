'''
SEAMLESS_ZOOM — A technique for seamless zooming between process models and process instances.
Copyright (C) 2025  Christoffer Rubensson

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

Website: https://hu-berlin.de/rubensson
E-Mail: {firstname.lastname}@hu-berlin.de
'''

import csv
import sys
import io
import os
import json
import pandas as pd
import tempfile
from flask import Blueprint, render_template, request, jsonify
from pathlib import Path
from src.utils.data_importing import load_event_log_from_tempfile
from src.orchestrator import process_log_for_d3js
from src.integrations.neo4j_queries import (
    build_anchor_application_sample_payload,
    fetch_application_instance_summaries,
)

# App directory
project_root = Path(__file__).resolve().parent.parent
sys.path.append(str(project_root))

bp = Blueprint("pages", __name__)

# Import allowance fo file extensions
ALLOWED_EXTENSIONS = {'csv', 'xes'}
def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

@bp.route("/")
def home():
    return render_template("pages/index.html")

@bp.route('/api/get_data')
def get_data():
    data_path = project_root / 'data' / 'example_data' / 'data-runningexample.csv'
    with data_path.open(newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        data = list(reader)
    return jsonify(data)


@bp.route('/api/multi_entity_sample/<mode>')
def get_multi_entity_sample(mode):
    sample_paths = {
        "local": project_root / 'data' / 'neo4j_samples' / 'instances' / 'Application_180427873' / 'local_sample_structure.json',
        "expanded": project_root / 'data' / 'neo4j_samples' / 'instances' / 'Application_180427873' / 'expanded_sample_structure.json',
    }
    sample_path = sample_paths.get(mode)
    if sample_path is None:
        return jsonify({'error': f'Unknown mode: {mode}'}), 400
    if not sample_path.exists():
        return jsonify({'error': f'Sample file not found for mode: {mode}'}), 404
    return jsonify(json.loads(sample_path.read_text(encoding='utf-8')))


MULTI_ENTITY_INSTANCES = [
    {
        "id": "Application_180427873",
        "label": "Instance 1: small",
        "description": "20 events, 33 DF edges, 1 offer",
    },
    {
        "id": "Application_1389621581",
        "label": "Instance 2: medium",
        "description": "41 events, 69 DF edges, 1 offer",
    },
    {
        "id": "Application_1020381296",
        "label": "Instance 3: complex",
        "description": "81 events, 141 DF edges, 2 offers",
    },
]


@bp.route('/api/multi_entity_instances')
def get_multi_entity_instances():
    """Return one page of application-centered prototype instances."""
    page = request.args.get("page", 1, type=int)
    page_size = request.args.get("page_size", 20, type=int)
    sort = request.args.get("sort", "event_count", type=str)
    order = request.args.get("order", "desc", type=str)
    application_search = request.args.get("application_search", "", type=str)
    min_events = request.args.get("min_events", 0, type=int)
    min_offers = request.args.get("min_offers", 0, type=int)
    only_cancelled = request.args.get("only_cancelled", "false", type=str).lower() == "true"

    try:
        return jsonify(fetch_application_instance_summaries(
            page=page,
            page_size=page_size,
            sort=sort,
            order=order,
            application_search=application_search,
            min_events=min_events,
            min_offers=min_offers,
            only_cancelled=only_cancelled,
        ))
    except Exception as exc:
        # Keep the demo usable when Neo4j is not running; the browser can still
        # navigate through the pre-exported examples.
        return jsonify({
            "page": 1,
            "pageSize": len(MULTI_ENTITY_INSTANCES),
            "total": len(MULTI_ENTITY_INSTANCES),
            "sort": "event_count",
            "order": "asc",
            "instances": [
                {
                    "id": instance["id"],
                    "label": instance["label"],
                    "description": instance["description"],
                }
                for instance in MULTI_ENTITY_INSTANCES
            ],
            "warning": str(exc),
        })


@bp.route('/api/multi_entity_sample/<application_id>/<mode>')
def get_multi_entity_instance_sample(application_id, mode):
    sample_paths = {
        "local": project_root / 'data' / 'neo4j_samples' / 'instances' / application_id / 'local_sample_structure.json',
        "expanded": project_root / 'data' / 'neo4j_samples' / 'instances' / application_id / 'expanded_sample_structure.json',
    }
    sample_path = sample_paths.get(mode)
    known_instance_ids = {instance["id"] for instance in MULTI_ENTITY_INSTANCES}
    if application_id not in known_instance_ids:
        return jsonify({'error': f'Unknown instance: {application_id}'}), 400
    if sample_path is None:
        return jsonify({'error': f'Unknown mode: {mode}'}), 400
    if not sample_path.exists():
        return jsonify({'error': f'Sample file not found: {application_id}/{mode}'}), 404
    return jsonify(json.loads(sample_path.read_text(encoding='utf-8')))


@bp.route('/api/multi_entity_live/<application_id>/<mode>')
def get_multi_entity_live_sample(application_id, mode):
    """Build one local or expanded application-centered instance from Neo4j."""
    if mode not in {"local", "expanded"}:
        return jsonify({'error': f'Unknown mode: {mode}'}), 400
    try:
        payload = build_anchor_application_sample_payload(
            application_id,
            mode=mode,
            selected_perspectives=["Offer", "Workflow"],
        )
        return jsonify(json.loads(json.dumps(payload, default=str)))
    except Exception as exc:
        return jsonify({'error': str(exc)}), 500

@bp.route('/api/upload_data', methods=['POST'])
def upload_data():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
    
    file = request.files['file']
    filename = file.filename
    ext = filename.rsplit('.', 1)[1].lower()

    if filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if not allowed_file(filename):
        return jsonify({'error': 'Invalid file type. Only {ALLOWED_EXTENSIONS} allowed.'}), 400
    
    try:
        if ext == 'csv':
            stream = io.StringIO(file.stream.read().decode("utf-8"), newline=None)
            reader = csv.DictReader(stream)
            data = list(reader)
        elif ext == 'xes':
            with tempfile.NamedTemporaryFile(delete=False, suffix=".xes") as tmp:
                file.save(tmp)
                tmp_path = tmp.name
            # dataframe
            df = load_event_log_from_tempfile(tmp_path)
            print("RAW df columns:", df.columns.tolist())
            # json
            df = process_log_for_d3js(df)
            print("PROCESSED df columns:", df.columns.tolist())
            print(df.head(3).to_dict(orient="records"))

            data = df.to_dict(orient='records')
            # Clean up temporary file
            os.remove(tmp_path)
        else:
            return jsonify({'error': 'Unsupported file type'}), 400
        return jsonify(data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500
