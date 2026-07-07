from routes.pages        import pages_bp
from routes.api_settings import settings_bp
from routes.api_courses  import courses_bp
from routes.api_video    import video_bp
from routes.api_progress import progress_bp
from routes.api_manage   import manage_bp
from routes.api_notes    import notes_bp

def register_routes(app):
    app.register_blueprint(pages_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(courses_bp)
    app.register_blueprint(video_bp)
    app.register_blueprint(progress_bp)
    app.register_blueprint(manage_bp)
    app.register_blueprint(notes_bp)
