"""Route blueprints, grouped by domain (spec 03).

`app.py` registers every blueprint in `all_blueprints`; each module keeps the
same absolute URLs the routes had on the monolithic app (no `url_prefix`), so the
frontend contract is unchanged.
"""

from .uploads import bp as uploads_bp
from .assets import bp as assets_bp
from .imagegen import bp as imagegen_bp
from .jobs_routes import bp as jobs_bp
from .projects import bp as projects_bp
from .animation import bp as animation_bp
from .export import bp as export_bp
from .serving import bp as serving_bp
from .stylize import bp as stylize_bp
from .dream import bp as dream_bp
from .settings import bp as settings_bp

all_blueprints = (
    uploads_bp,
    assets_bp,
    imagegen_bp,
    jobs_bp,
    projects_bp,
    animation_bp,
    export_bp,
    serving_bp,
    stylize_bp,
    dream_bp,
    settings_bp,
)
