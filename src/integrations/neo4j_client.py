"""Helpers for creating Neo4j connections from environment variables."""

import os

from neo4j import GraphDatabase


def get_neo4j_driver():
    """Create a Neo4j driver from environment variables."""
    uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    username = os.getenv("NEO4J_USER") or os.getenv("NEO4J_USERNAME", "neo4j")
    password = os.getenv("NEO4J_PASSWORD", "1234")
    return GraphDatabase.driver(uri, auth=(username, password))


def get_neo4j_database():
    """Return the configured Neo4j database name, if any."""
    return os.getenv("NEO4J_DATABASE")
